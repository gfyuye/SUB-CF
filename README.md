# CF-Workers-SUB v16 使用与部署说明

> 自建节点 + 机场聚合订阅转换 Worker。无 KV / 无 D1 / 无持久化，适配 Cloudflare 免费版。
> 支持 Workers 与 Pages（`_worker.js` 高级模式）两种部署方式。

---

## 一、项目简介

把「自建节点（`SELF_NODES`）」和「机场订阅源（`LINK`/`LINKSUB`）」聚合成一个订阅，并按客户端 UA 自动输出 Base64 / Clash / Sing-box / Surge / Quantumult X / Loon 格式。

**仓库结构：**

```
repo/
├── worker.js              # Workers 部署入口
├── _worker.js             # Pages 部署入口（内容与 worker.js 相同）
├── wrangler.toml          # Workers 配置
├── wrangler.pages.toml    # Pages CLI 部署配置
└── README.md
```

---

## 二、访问方式

假设域名为 `https://sub.example.com`，`TOKEN=mysecret`：

| 用途 | 地址 |
|---|---|
| 自适应订阅（推荐） | `https://sub.example.com/mysecret` |
| Base64（不经 SUBAPI，自建节点明文） | `https://sub.example.com/mysecret?b64` |
| Clash / Sing-box / Surge / QX / Loon | `.../mysecret?clash`、`?sb`、`?surge`、`?quanx`、`?loon` |
| 访客订阅（需设 `GUESTTOKEN`） | `https://sub.example.com/?token=<GUESTTOKEN>` 及 `&b64/&clash/...` |

> `TOKEN=auto` 时默认 503，需设 `ALLOW_AUTO_TOKEN=1` 才放行（仅调试）。

---

## 三、环境变量

### 必填

| 变量 | 说明 |
|---|---|
| `TOKEN` | 管理员 token，随机强口令。 |
| `GUESTTOKEN` | 访客 token，未设置时访客路径 503，须与 `TOKEN` 不同。 |

### 节点与订阅源

| 变量 | 说明 |
|---|---|
| `SELF_NODES` | 自建节点，多行，支持 vless/vmess/trojan/ss/ssr/hysteria/hysteria2/tuic。**只混淆这一份**。 |
| `LINK` | 机场订阅源 URL，多行，`https://` 开头。不混淆。 |
| `LINKSUB` | 额外订阅源 URL（可选）。 |

> URL 不能含 `|`，不能指向内网 / 非 80/443 端口。

### 订阅转换

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SUBAPI` | `SUBAPI.fxxk.dedyn.io` | 订阅转换后端。 |
| `SUBCONFIG` | ACL4SSR 多国 | 转换配置 URL。 |
| `SUBCONVERTER_UA` | 空 | 自建 SUBAPI 的 UA 关键词。 |
| `SUB_HOST_ALLOW` | 空 | 订阅源域名白名单，逗号分隔。 |
| `SUBNAME` | `CF-Workers-SUB` | 下载文件名。 |
| `SUBUPTIME` | `6` | 更新间隔（小时）。 |

### 严格模式

| 变量 | 默认 | 说明 |
|---|---|---|
| `STRICT_SELF_NODES` | `0` | `0`=宽松；`1`=严格（missing/partial→502）；`2`=超严格（unObfuscated 也 502）。 |

### 可选

| 变量 | 说明 |
|---|---|
| `TGTOKEN` / `TGID` / `TG=1` | Telegram 通知。 |
| `URL` / `URL302` | 未授权访问时反代 / 302 跳转。 |

---

## 四、Workers 部署

### Dashboard

1. **Workers & Pages → Create → Worker** → 命名 → Deploy。
2. **Edit code** → 粘贴 `worker.js` 全部内容 → Save and Deploy。
3. **Settings → Variables and Secrets** 添加 `TOKEN`、`GUESTTOKEN`（Secret）、`SELF_NODES`、`LINK`（Text）等。
4. 访问 `https://<worker>.workers.dev/<TOKEN>` 验证。

### Wrangler CLI

仓库已含 `wrangler.wowrker.toml`：

```bash
wrangler deploy
```

敏感变量：

```bash
wrangler secret put TOKEN
wrangler secret put GUESTTOKEN
wrangler secret put SELF_NODES
wrangler secret put LINK
```

> **不要**在 `wrangler.toml` 写 `[placement]`。本项目无固定上游，保持默认让 Worker 随用户就近运行最优；显式指定区域（如东京）会让其他地区用户增加延迟。

---

## 五、Pages 部署

Pages 常规 Functions 不支持导出 `fetch` 的模块，必须使用 **`_worker.js` 高级模式**（仓库已含 `_worker.js`）。

### Dashboard 直传

1. 上传仓库根目录（含 `_worker.js`）为 Pages 项目 → Deploy。
2. **Settings → Variables and Secrets** 添加与 Workers 相同的变量。
3. 访问 `https://<project>.pages.dev/<TOKEN>` 验证。

> `_worker.js` 会接管所有请求。鉴权失败时代码返回 nginx 占位页或按 `URL`/`URL302` 处理，不会自动 fallback 到 `index.html`。若需静态首页，在鉴权失败分支加 `if (env.ASSETS) return env.ASSETS.fetch(request);`。

### Wrangler CLI

仓库已含 `wrangler.pages.toml`：

```bash
wrangler pages deploy . --config wrangler.toml
```

> Pages 配置与 Workers **不共享字段**：`main` 在 Pages 不适用，`pages_build_output_dir` 为必填。仓库已分别提供 `wrangler.wowrker.toml`（Workers）与 `wrangler.toml`（Pages），避免解析冲突。

### Git 集成

若使用 Git 集成自动识别 Pages 配置，Cloudflare 通常读取名为 `wrangler.toml` 的文件。**不要**把 Pages 配置直接命名为 `wrangler.toml` 覆盖 Workers 配置；建议 Git 集成时在 Dashboard 配置变量、不依赖 Wrangler 文件，或维护独立分支。

### 推荐

**本项目首选 Workers 部署**，最直接、零冲突。Pages 适合已有 Pages 项目或需要静态首页的场景。

---

## 六、WAF 限流（可选）

v16 无内置限流，建议 Dashboard → **Security → WAF → Rate Limiting**（免费版 1 条规则，10 秒周期，按 IP）：

- 匹配：`(http.request.uri.query contains "token=") and not (http.request.headers["user-agent"] contains "subconverter")`
- 计数：IP，10 秒，阈值 30，Block 60 秒

---

## 七、安全模型与已知局限（必读）

1. **自建节点经 SUBAPI 转换**，可能被丢弃/改写。SUBAPI 逐字保留占位符时才能精确恢复，改写 → 502。**上线前必须用目标 SUBAPI 验证**（`example.com` 域名、UUID 格式、`__PH__` 下划线、SSR base64）。
2. **`STRICT_SELF_NODES=1` 是"尽力检测"**：missing/partial → 502；多节点共用同一 real 时 `out.includes(real)` 无法区分归属，可能漏报单节点字段丢失；unObfuscated 节点（wireguard、非 JSON vmess、解码失败 SS/SSR）只 `X-Warning`，不 502。
3. **`STRICT_SELF_NODES=2`**：存在 unObfuscated 节点也 502。
4. **`X-Warning` 客户端通常不读**，严格模式请查 Worker 日志或 502 响应体。
5. **混淆是"防 SUBAPI 日志明文"**，不是"防确定性映射攻击"。同一 real → 同一占位符，攻击者同时拿到混淆体和原文可建映射表。敏感节点建议**自建 SUBAPI**。
6. **`?b64` 路径返回自建节点明文**，不经 SUBAPI，节点完整。SUBAPI 不可靠时引导用户用 `?b64` 直连。
7. **订阅源 URL 和节点仍暴露给 SUBAPI**（回拉架构固有）。
8. **路径、节点名、端口不混淆**（会破坏 SUBAPI 解析）。
9. **fakeToken + UA 白名单是"防误访问"，非强认证**（UA 可伪造）。fakeToken 按 10 分钟窗口派生。
10. 恢复假设 real 不含 `\x00` 和占位符格式字符串（实际不会发生）。
11. 日志"节点索引"是节点序号（跳过注释/空行），502/日志同时给出行号便于定位。

---

## 八、常见问题

**Q1：订阅 502 "SUBAPI 改写了占位符"？**
换不改写占位符的 SUBAPI，或用 `?b64` 直连，或自建 SUBAPI。

**Q2：订阅缺自建节点？**
SUBAPI 丢弃了节点。设 `STRICT_SELF_NODES=1` 让缺失可见，或 `=2` 要求所有节点可混淆。彻底解决：自建 SUBAPI 或 `?b64` 直连。

**Q3：`wireguard://` 等未混淆？**
混淆只覆盖 vless/vmess/trojan/ss/ssr/hysteria/hysteria2/tuic。其他协议记 `unObfuscated`，`STRICT_SELF_NODES=2` 时 502。

**Q4：访客订阅 503？**
未设 `GUESTTOKEN`，设置后可用。

**Q5：能不用 SUBAPI 吗？**
可以，用 `?b64` 或 v2rayN 类 UA 直连，返回自建节点明文 + 订阅源节点，不经 SUBAPI。

**Q6：需要 KV / D1 吗？**
不需要。v16 无 KV / 无 D1 / 无持久化。

**Q7：需要指定部署区域吗？**
不需要。本项目无固定上游，保持默认让 Worker 随用户就近运行最优。**不要**写 `[placement]`。

**Q8：`wrangler.toml` 能同时用于 Workers 和 Pages 吗？**
不能完美共存。两者字段冲突（Workers 需 `main`，Pages 需 `pages_build_output_dir` 且 `main` 不适用）。仓库已分别提供 `wrangler.toml` 与 `wrangler.pages.toml`。

---

## 九、许可

基于 cmliu/CF-Workers-SUB 思路演进。请遵守所在地区法律法规，仅用于合法用途。
