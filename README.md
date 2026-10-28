# CF-Workers-SUB v16 使用与部署说明（README）

> 自建节点 + 机场聚合订阅转换 Worker。无 KV / 无 D1 / 无持久化，适配 Cloudflare 免费版。
> 支持 Workers 与 Pages（`_worker.js` 高级模式）两种部署方式。

---

## 一、项目简介

把「自建节点（`SELF_NODES`）」和「机场订阅源（`LINK`/`LINKSUB`）」聚合成一个订阅，并按客户端 UA 自动输出 Base64 / Clash / Sing-box / Surge / Quantumult X / Loon 格式。

核心特性：

- **无状态**：不依赖 KV / D1，纯 Workers 运行。
- **自建节点混淆**：自建节点经 SUBAPI 转换前，凭证与服务器地址会被替换为确定性占位符，转换后本地恢复，降低 SUBAPI 日志明文泄漏风险。
- **严格完整性检测**：`STRICT_SELF_NODES` 可选宽松 / 严格 / 超严格三档，检测自建节点是否被 SUBAPI 丢弃或部分改写。
- **SSRF 防护**：订阅源协议 / 内网 / 端口 / 域名白名单逐跳校验，重定向手动跟随。
- **多格式自适应**：按 UA 或 `?clash` / `?sb` / `?surge` / `?quanx` / `?loon` / `?b64` 参数输出。

---

## 二、访问方式

假设 Worker/Pages 域名为 `https://sub.example.com`，`TOKEN=mysecret`：

| 用途 | 地址 |
|---|---|
| 自适应订阅（推荐给客户端） | `https://sub.example.com/mysecret` |
| Base64 订阅（不经 SUBAPI，自建节点明文） | `https://sub.example.com/mysecret?b64` |
| Clash | `https://sub.example.com/mysecret?clash` |
| Sing-box | `https://sub.example.com/mysecret?sb` |
| Surge | `https://sub.example.com/mysecret?surge` |
| Quantumult X | `https://sub.example.com/mysecret?quanx` |
| Loon | `https://sub.example.com/mysecret?loon` |
| 访客订阅（需设 `GUESTTOKEN`） | `https://sub.example.com/?token=<GUESTTOKEN>` 及 `&b64/&clash/...` |

> `TOKEN=auto` 时默认返回 503，需显式设 `ALLOW_AUTO_TOKEN=1` 才放行（不推荐生产）。

---

## 三、环境变量

### 必填

| 变量 | 说明 |
|---|---|
| `TOKEN` | 管理员 token，用于访问订阅与路径鉴权。**必须设置为随机强口令**。 |
| `GUESTTOKEN` | 访客 token。未设置时访客路径返回 503。**必须与 `TOKEN` 不同**。 |

### 节点与订阅源

| 变量 | 说明 |
|---|---|
| `SELF_NODES` | 自建节点，多行，支持 `vless://`、`vmess://`、`trojan://`、`ss://`、`ssr://`、`hysteria://`、`hysteria2://`/`hy2://`、`tuic://`。**只混淆这一份**。 |
| `LINK` | 机场订阅源 URL，多行，`https://` 开头。不混淆，由 SUBAPI 自己拉。 |
| `LINKSUB` | 额外订阅源 URL（可选，同样不混淆）。 |

> `LINK`/`LINKSUB` 中 URL **不能含 `|`**（会被跳过并告警），也不能指向内网 / 非 80/443 端口。

### 订阅转换

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SUBAPI` | `SUBAPI.fxxk.dedyn.io` | 订阅转换后端域名。 |
| `SUBCONFIG` | ACL4SSR 多国配置 | 订阅转换配置文件 URL。 |
| `SUBCONVERTER_UA` | 空 | 自建 SUBAPI 的 UA 关键词（补充 fakeToken 回拉白名单）。 |
| `SUB_HOST_ALLOW` | 空 | 订阅源域名白名单，逗号分隔。未设置则只做内网/端口校验。 |
| `SUBNAME` | `CF-Workers-SUB` | 下载文件名。 |
| `SUBUPTIME` | `6` | `Profile-Update-Interval` 小时数。 |

### 严格模式

| 变量 | 默认值 | 说明 |
|---|---|---|
| `STRICT_SELF_NODES` | `0` | `0`=宽松（仅日志警告）；`1`=严格（missing/partial → 502）；`2`=超严格（unObfuscated 也 502）。 |

### 通知与代理（可选）

| 变量 | 说明 |
|---|---|
| `TGTOKEN` / `TGID` / `TG=1` | Telegram 机器人通知（异常访问、订阅获取）。 |
| `URL` | 未授权访问时反代到指定地址（逗号分隔多地址随机）。 |
| `URL302` | 未授权访问时 302 跳转地址。 |
| `ALLOW_AUTO_TOKEN=1` | 允许 `TOKEN=auto`（仅调试用）。 |

---

## 四、Workers 部署方案

### 方式 A：Cloudflare Dashboard（推荐新手）

1. 登录 Cloudflare Dashboard → **Workers & Pages** → **Create** → **Worker**。
2. 命名（如 `cf-workers-sub`）→ **Deploy**。
3. 进入 Worker → **Edit code**，把 `worker.js` 全部内容粘贴进去 → **Save and Deploy**。
4. **Settings → Variables and Secrets**，添加：
   - `TOKEN`（Secret，必填）
   - `GUESTTOKEN`（Secret，必填）
   - `SELF_NODES`（Text，自建节点多行）
   - `LINK`（Text，机场订阅源多行）
   - 其余按需（`SUBAPI`、`SUBCONFIG`、`STRICT_SELF_NODES` 等）
5. **Settings → Triggers → Custom Domains** 绑定自定义域名（可选）。
6. 访问 `https://<worker>.workers.dev/<TOKEN>` 验证。

> 无需绑定 KV / D1，无需任何持久化。

### 方式 B：Wrangler CLI（推荐生产）

`wrangler.toml`：

```toml
name = "cf-workers-sub"
main = "worker.js"
compatibility_date = "2024-01-01"

# 非敏感变量
[vars]
SUBAPI = "SUBAPI.fxxk.dedyn.io"
SUBCONFIG = "https://raw.githubusercontent.com/cmliu/ACL4SSR/main/Clash/config/ACL4SSR_Online_MultiCountry.ini"
STRICT_SELF_NODES = "1"
SUB_HOST_ALLOW = "raw.githubusercontent.com,githubusercontent.com"
```

敏感变量用 Secret：

```bash
wrangler secret put TOKEN
wrangler secret put GUESTTOKEN
wrangler secret put SELF_NODES
wrangler secret put LINK
```

部署：

```bash
wrangler deploy
```

> 注意：`SELF_NODES` 含多行节点，用 `wrangler secret put` 粘贴时确保换行保留；也可用 Dashboard 的 Text 变量。

---

## 五、Pages 部署方案

Pages 常规 Functions 是文件路径路由，**不支持**直接导出 `fetch` 处理器的模块。要运行本项目，需使用 **`_worker.js` 高级模式**。

### 方式 A：Dashboard 直传（无构建）

1. 本地建目录，放入：
   ```
   my-sub-pages/
   ├── _worker.js        ← 把 worker.js 全部内容放入
   └── index.html        ← 可选，静态首页（见下方兜底说明）
   ```
2. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Upload assets**。
3. 上传 `my-sub-pages/` 目录 → **Deploy**。
4. **Settings → Variables and Secrets** 添加与 Workers 相同的变量（`TOKEN`、`GUESTTOKEN`、`SELF_NODES`、`LINK` 等）。
5. 访问 `https://<project>.pages.dev/<TOKEN>` 验证。

> **兜底说明**：启用 `_worker.js` 后，Pages 把所有请求交给该脚本。你的代码在鉴权失败时会返回 nginx 占位页或按 `URL`/`URL302` 处理，**不会**自动 fallback 到 `index.html`。若需要静态首页，需在代码鉴权失败分支加：
> ```js
> if (env.ASSETS) return env.ASSETS.fetch(request);
> ```
> 若不需静态资源，可忽略。

### 方式 B：Git 集成（推荐）

仓库结构：

```
repo/
├── functions/          ← 不要用常规 Functions
├── _worker.js          ← 本项目代码
├── index.html          ← 可选
└── wrangler.toml       ← 可选，用于 Pages 项目配置
```

`wrangler.toml`（Pages）：

```toml
name = "cf-workers-sub-pages"
pages_build_output_dir = "."
compatibility_date = "2024-01-01"

[vars]
SUBAPI = "SUBAPI.fxxk.dedyn.io"
STRICT_SELF_NODES = "1"
```

1. 推送到 GitHub。
2. Pages → **Connect to Git** → 选仓库 → 构建命令留空，输出目录 `.`。
3. **Settings → Variables and Secrets** 添加敏感变量。
4. Deploy。

> Pages 的 `_worker.js` 模式与 Workers 运行时兼容，`env` 访问方式一致，D1/KV 绑定（本项目不需要）在 Pages 中也支持。

### Workers vs Pages 选择建议

| 维度 | Workers | Pages `_worker.js` |
|---|---|---|
| 部署简单度 | ✅ 原生支持 | ⚠️ 需 `_worker.js` 模式 |
| 静态资源 | 需 Workers Assets | ✅ 天然支持 |
| 本项目适配 | ✅ 直接粘贴 | ✅ 放入 `_worker.js` |
| 推荐 | **首选** | 需要静态站点时用 |

**本项目推荐 Workers 部署**，最直接、限制最少。

---

## 六、WAF 限流（可选，防滥用）

v16 无内置限流，建议在 Cloudflare Dashboard → **Security → WAF → Rate Limiting** 配置（免费版 1 条规则，10 秒周期，按 IP）：

- 匹配：`(http.request.uri.query contains "token=") and not (http.request.headers["user-agent"] contains "subconverter")`
- 计数：IP，10 秒，阈值 30，Block 60 秒

效果：真实用户高频被限；subconverter 回源不匹配、不误伤；fakeToken 非 subconverter UA 攻击者被限。

---

## 七、安全模型与已知局限（必读）

1. **自建节点经 SUBAPI 转换**，可能被丢弃/改写。SUBAPI 逐字保留占位符时才能精确恢复；改写占位符 → 502。**上线前必须用目标 SUBAPI 验证**（尤其 `example.com` 域名、UUID 格式、`__PH__` 下划线、SSR base64 参数）。
2. **`STRICT_SELF_NODES=1` 是"尽力检测"**：missing（全丢）/ partial（部分字段丢）→ 502；对"多节点共用同一 real（server/password）"场景，`out.includes(real)` 无法区分该 real 属于哪个节点，可能漏报单节点字段丢失；unObfuscated 节点（wireguard、非 JSON vmess、解码失败 SS/SSR）无法检测完整性，只 `X-Warning`，不 502。
3. **`STRICT_SELF_NODES=2` 超严格**：存在 unObfuscated 节点也 502，要求所有节点可混淆。
4. **`X-Warning` 是尽力提示**：订阅客户端通常不读响应头，用户可能看不到。严格模式请查 Worker 日志或 502 响应体。
5. **混淆是"防 SUBAPI 日志明文"**，不是"防确定性映射攻击"。同一 real → 同一占位符，攻击者若同时拿到混淆体和原文可建映射表。敏感节点建议**自建 SUBAPI**。
6. **base64 路径（`?b64`）返回自建节点明文**，不经 SUBAPI，自建节点完整。SUBAPI 不可靠时，引导用户用 `?b64` 直连。
7. **订阅源 URL 和订阅源节点仍暴露给 SUBAPI**（回拉架构固有）。
8. **路径、节点名、端口不混淆**（混淆会破坏 SUBAPI 解析）。
9. **fakeToken + UA 白名单是"防误访问"，不是强认证**（UA 可伪造）。fakeToken 按 10 分钟窗口派生。
10. **恢复假设 real 不含 `\x00` 和占位符格式字符串**（实际不会发生）。
11. **日志"节点索引"是节点序号**（跳过注释/空行），不是 `SELF_NODES` 行号；502/日志同时给出行号便于定位。

---

## 八、常见问题

**Q1：订阅 502 "SUBAPI 改写了占位符"？**
目标 SUBAPI 对占位符做了改写（重命名/编码/格式校验）。解决：
- 换一个不改写占位符的 SUBAPI；或
- 用 `?b64` 直连（不经 SUBAPI）；或
- 自建 SUBAPI。

**Q2：订阅缺自建节点？**
SUBAPI 丢弃了部分节点。设 `STRICT_SELF_NODES=1` 让缺失可见（502 + 日志），或 `=2` 要求所有节点可混淆。彻底解决：自建 SUBAPI 或 `?b64` 直连。

**Q3：`wireguard://` 等非支持协议节点没混淆？**
混淆只覆盖 `SELF_NODES` 中的 `vless/vmess/trojan/ss/ssr/hysteria/hysteria2/tuic`。其他协议记 `unObfuscated`，`STRICT_SELF_NODES=2` 时 502。

**Q4：访客订阅返回 503 "访客订阅未启用"？**
未设 `GUESTTOKEN`。设置后访客路径可用。

**Q5：能不用 SUBAPI 吗？**
可以。用 `?b64` 或 v2rayN 类 UA 直连，返回自建节点明文 + 订阅源节点，不经 SUBAPI。代价是客户端需支持 Base64 订阅，且 Clash 等格式需客户端自己转换。

**Q6：需要 KV / D1 吗？**
不需要。v16 无 KV / 无 D1 / 无持久化，纯 Workers 运行。

---

## 九、许可与致谢

基于 cmliu/CF-Workers-SUB 思路演进。请遵守所在地区法律法规，仅用于合法用途。
