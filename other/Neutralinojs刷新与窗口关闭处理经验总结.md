# Neutralinojs 刷新/自动刷新与窗口关闭处理经验总结

> 本文档基于 `dataset-tag-editor-neu` 项目在调试「页面刷新 / 修改文件自动刷新后功能失效、无法关闭」问题时的排查过程整理而成，记录 Neutralinojs 的核心通信机制与常见坑，供后续维护参考。

## 1. 基本架构

Neutralinojs 采用「本地 WebSocket」的客户端-服务端通信模式：

- **框架核心（native 进程）**：一个 C++ 程序，同时承担本地静态服务器（serve 前端资源）和 WebSocket 服务端（处理原生 API 调用）。
- **前端（webview）**：加载 `resources/js/neutralino.js` 客户端库后，通过 `Neutralino.init()` 建立与核心的 WebSocket 连接，之后用 `Neutralino.filesystem.*`、`Neutralino.os.*` 等 API 与本地系统交互。
- 全局变量（`NL_TOKEN`、`NL_PORT`、`NL_PATH`、`NL_ARGS` 等）由框架核心在响应 `neutralino.js` 请求时，以 `var NL_XXX=...` 片段的形式 **prepend** 到该文件最前面（参见 `settings.cpp::getGlobalVars()` 与 `server/router.cpp::serve()`）。

关键点：**不调用 `Neutralino.init()` 就不会有任何 WebSocket 连接，所有原生 API 都会失效。**

## 2. Token 安全机制（`tokenSecurity`）

配置文件 `neutralino.config.json` 中的 `tokenSecurity` 有两个取值：

| 取值 | 行为 |
| --- | --- |
| `one-time`（默认） | 服务端**只发送一次** token，客户端把它持久化到 `sessionStorage`。其他客户端访问会收到 `NE_RT_INVTOKN` 错误。 |
| `none` | 每次都发送 token，任何新客户端都能访问。**若使用了 `filesystem`/`os` 等危险 API，切勿使用 `none`。** |

关键实现细节（来自框架源码 `auth/authbasic.cpp`）：

```cpp
// 首次调用返回 token，之后（one-time 模式）返回空字符串
string getToken() {
    if(tokenSent && tokenSecurity == authbasic::TokenSecurityOneTime) {
        return "";
    }
    tokenSent = true;
    return authbasic::getTokenInternal();
}

// 校验始终比对内存中保存的 token，token 本身不会“被消耗”
bool verifyToken(const string &accessToken)     { return token == accessToken; }
bool verifyConnectToken(const string &inConnectToken) { return connectToken == inConnectToken; }
```

因此：

- **`window.NL_TOKEN` 只在首次加载时有值，刷新后为空字符串**（这是本次问题的核心原因）。
- **token 本身不会失效**，刷新后只要从 `sessionStorage` 取回即可继续使用。

Token 格式为 `nlToken = "前缀.连接令牌"`（例如 `1_xxx.connectToken`）：

- WebSocket 握手用 `connectToken`（客户端通过 `nlToken.split(".")[1]` 取出）。
- 每次原生 API 调用附带完整 `nlToken` 作为 `accessToken`。

## 3. 客户端连接与 `Neutralino.init()`

客户端库（`resources/js/neutralino.js`）关键逻辑：

```js
// 建立连接（仅在 init() 中被调用）
function d(){
    window.NL_TOKEN && sessionStorage.setItem("NL_TOKEN", window.NL_TOKEN); // 首次加载时持久化 token
    const e = m().split(".")[1]; // 取出 connectToken
    a = new WebSocket(`ws://${o}:${window.NL_PORT}?connectToken=${e}`);
    // 注册 message / open / close / error 事件
}

// 取 token：优先 window.NL_TOKEN，回退到 sessionStorage
function m(){ return window.NL_TOKEN || sessionStorage.getItem("NL_TOKEN") || ""; }

// 原生调用：WebSocket 未 OPEN 时进入队列 c，连接建立后统一 flush
function l(e,t){
    return new Promise((n,r)=>{
        if(a?.readyState != WebSocket.OPEN) {
            c.push({method:e, data:t, resolve:n, reject:r}); // 排队，promise 挂起
            return;
        }
        a.send(JSON.stringify({id:uuid(), method:e, data:t, accessToken:m()}));
    });
}
```

要点：

- `Neutralino.init()` 是建立连接的唯一入口，内部有 `K` 标志防止重复初始化。
- 在 WebSocket 未建立前调用任何原生 API，请求会进入队列 `c`，**promise 永远 pending**，直到连接打开后由 `open` 事件触发 flush。
- 因此 **在 `init()` 之前做需要原生 API 的操作（哪怕只是写日志）会形成死锁**：日志等待连接 → 连接等待 `init()` → `init()` 排在日志之后永远执行不到。

## 4. 刷新与自动刷新机制

### 4.1 自动刷新（`neu run` 开发模式）

- `neu run` 默认给框架传 `--neu-dev-auto-reload`，并用 chokidar 监听 `resources/` 目录。
- 文件变化 → neu CLI 通过 WebSocket 向框架发 `app.broadcast`，事件名为 `neuDev_reloadApp` → 框架广播给客户端。
- 客户端在 `init()` 中注册了该事件监听器，收到后执行 `location.reload()`：

```js
window.NL_ARGS.find(e => "--neu-dev-auto-reload" == e) &&
    t("neuDev_reloadApp", async () => { await E("Reloading the application..."); location.reload(); });
```

- 页面里手动触发的 `location.reload()`（例如“恢复默认设置”按钮）走的是同样的刷新流程。

### 4.2 刷新后会发生什么

1. 页面重新请求 `neutralino.js`，框架再次注入全局变量，但 `NL_TOKEN` 因为 one-time 机制已变为空字符串。
2. 客户端 `m()` 自动回退到 `sessionStorage` 取回首次加载时保存的 token。
3. 用该 token 重新建立 WebSocket，原生 API 恢复正常。

**结论：只要 `Neutralino.init()` 被无条件调用，刷新后客户端能借助 `sessionStorage` 自动重连，功能不受影响。**

## 5. 窗口关闭机制

- 配置项 `modes.window.exitProcessOnClose`：
  - `true`：点击关闭按钮直接退出进程。
  - `false`（本项目取值）：框架**不退出**，而是向客户端派发 `windowClose` 事件，由前端决定是否退出。
- 因此 `exitProcessOnClose: false` 时，前端必须监听 `windowClose` 并显式调用 `Neutralino.app.exit()`，否则点关闭无反应：

```js
Neutralino.events.on("windowClose", () => {
    Neutralino.app.exit();
});
```

该事件通过 WebSocket 送达客户端，所以**监听器未注册，或 WebSocket 未连接，都无法关闭窗口**。

## 6. 本次踩过的坑（务必避免）

### 坑 1：在 `Neutralino.init()` 之前调用原生 API（死锁）

错误示例：

```js
async function start() {
    const log = async (msg) => {
        await Neutralino.filesystem.appendFile(NL_PATH + "/.reload-log", msg + "\n"); // 依赖连接
    };
    await log("start() begin...");   // ❌ 先调用了原生 API
    await Neutralino.init();          // ❌ 连接建立排在后面，永远执行不到
}
```

`log()` 里的文件操作在连接未建立时进入队列并永久挂起，`start()` 卡死在第一个 `await log(...)`，`init()` 永远不被执行 → 界面打开即功能失效。

正确写法：**先 `Neutralino.init()`，再使用任何原生 API。**

### 坑 2：用 `window.NL_TOKEN` 是否存在来判断是否需要初始化/注册事件

错误示例：

```js
if (window.NL_TOKEN) {
    await Neutralino.init();
}
if (window.NL_TOKEN) {
    Neutralino.events.on("windowClose", () => Neutralino.app.exit());
}
```

`window.NL_TOKEN` 在 one-time 模式下**只在首次加载有值，刷新后为空**，导致刷新后：

- `init()` 被跳过 → WebSocket 从未建立 → 所有功能失效；
- `windowClose` 未注册 → 无法关闭窗口。

正确写法：**`init()` 与 `windowClose` 注册都必须无条件执行**，令牌回退交给客户端库的 `sessionStorage` 机制处理。

## 7. 正确的入口代码模板

```js
// main.js
import { initApp } from "./modules/app.js";
import { setupUI } from "./modules/ui.js";

// 始终注册关闭处理（无条件）
Neutralino.events.on("windowClose", () => {
    Neutralino.app.exit();
});

async function start() {
    try {
        // 1. 先建立 WebSocket 连接（无条件），之后才能使用任何原生 API
        await Neutralino.init();

        // 2. 再执行依赖原生 API 的业务初始化
        await initApp();
        await setupUI();
    } catch (e) {
        console.error("startup error", e);
    }
}

start();
```

## 8. 开发/排查要点速查

- **启动/关闭**：`neu run` 启动；`exitProcessOnClose: false` 时靠前端监听 `windowClose` 调 `Neutralino.app.exit()`。
- **令牌来源**：首次加载 `window.NL_TOKEN` 有值并写入 `sessionStorage`；刷新后 `window.NL_TOKEN` 为空，靠 `sessionStorage` 回退。二者都不必有值判断。
- **鉴权错误**：客户端收到 `NE_RT_INVTOKN` 会关闭 WebSocket 并清空页面显示错误；`NE_CL_IVCTOKN` 表示连接握手令牌无效。
- **调试日志**：框架日志写入 `neutralinojs.log`；`--export-auth-info` 会把 `nlToken`/`nlConnectToken`/`nlPort` 写到 `.tmp/auth_info.json`（外部进程可据此连接调试）。
- **令牌校验**：`verifyToken`/`verifyConnectToken` 始终比对内存 token，token 不因重连失效，因此刷新重连是安全可支持的。
