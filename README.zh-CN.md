# iWind AIFin Connector

[English](README.md) | 中文

一个自行托管、只读的连接层，用来把万得（Wind）的金融数据 MCP 服务接入 ChatGPT Work、Grok Web、Codex 以及其他支持 MCP 的 Agent。

这个仓库不是已经托管好的数据服务，也不附带万得权限。你需要使用自己的万得账户和 API Key，把网关部署到自己的 Cloudflare 账户，再让 Agent 通过 OAuth 连接部署后的 MCP 地址。

## 这个项目解决什么问题

万得通过多个 MCP 服务提供金融数据。如果每个 Agent 都分别配置六个服务和多枚 API Key，维护会很麻烦；当某一枚 Key 的额度耗尽时，也容易出现不透明或不安全的切换行为。

iWind AIFin Connector 把它们整理成一个稳定的 OAuth MCP 入口和一个运行时中立的 Skill：

```text
ChatGPT Work / Grok Web / 本地 Agent
              │
              ├── Skill：意图路由、数据质量检查、失败即停止规则
              │
              └── OAuth MCP 连接
                         │
                         ▼
                Cloudflare Worker 网关
                ├── OAuth 与访问控制
                ├── 31 个只读工具清单
                ├── 有序 KeyPool 严格串行（active primary ring 为五槽）
                └── 脱敏的运维提示
                         │
                         ▼
                   六组万得 MCP 服务
```

下文提到的 Cloudflare Plugin 是配置和维护助手，可以帮助 Agent 创建或检查 Cloudflare 资源，但不在正式的万得查询数据链路中。

## 它能实现什么

| 能力 | 实际含义 |
| --- | --- |
| 一个 MCP 入口 | 客户端只连接一个已部署的 `{PUBLIC_ORIGIN}/mcp`，不用分别维护六个万得地址。 |
| 31 个只读工具 | 覆盖股票、基金、指数、宏观经济、公告/新闻和支持的金融分析。 |
| 运行时中立 Skill | 同一个 Skill zip 可以在支持的 Agent 中提供工具路由、身份验证、串行调用、结果检查和人类可读的运维提示。 |
| OAuth 保护 | 万得 Key 始终留在网关后面；客户端只向网关授权，不会拿到万得凭据。 |
| 按额度自动轮换 | active primary generation 使用 `key-05 → key-04 → key-03 → key-02 → key-01`；持久化游标稳定使用当前槽位，只在获准的切换事件上前进。 |
| 严格串行 | 私有 Key 池同时最多只有一个万得请求。增加更多 Key 提升的是故障切换容量，不是并行吞吐。 |
| 失败即停止 | 工具缺失、证券身份不明确、市场不受支持或请求失败时停止，不用猜测值、网页数据或泛化分析冒充万得结果。 |
| 可复现交付 | 测试、固定 11 文件的确定性 Skill 包、clean-room 校验和精确 Secret 扫描共同保护发布流程。 |

### 已集成的万得领域

| 领域 | 工具数 | 常见用途 |
| --- | ---: | --- |
| 股票 | 10 | 身份、快照、分钟数据、K 线、财务、股东、事件、技术指标、筛选和风险。 |
| 基金和 ETF | 10 | 身份、价格、净值、持仓、持有人、基金经理、规模、财务和业绩。 |
| 指数 | 6 | 身份、快照、点位序列、K 线、估值和技术指标。 |
| 经济数据 | 2 | 宏观经济、行业和外汇序列。 |
| 金融文档 | 2 | 上市公司公告和财经新闻。 |
| 分析 | 1 | 预定义工具无法表达、但服务支持的自定义金融计算。 |

网关不提供交易或写入操作。

## API Key 是怎么轮换的

稳定 catalog 包含 `key-01` 至 `key-05`。active primary layout `ring-primary-v2` 的顺序是 `key-05 → key-04 → key-03 → key-02 → key-01`，其 KeyPool 持久化保存表示当前槽位的游标。原来的 `key-01 → key-02` pool 仍作为 legacy generation 保留，用于 rollback 兼容和 OAuth replay，不承接新的业务调用。

本仓库的 primary-layout revision 尚待合并；当前已部署的 Cloudflare production 仍是 legacy 两槽 generation，只有在单独批准 cutover 后才会切换。本说明不把该 cutover 写成已完成。

1. 新 primary v2 pool 从 `key-05` 开始；普通成功不会移动游标，因此请求不会在 Key 之间交替。
2. 只有精确的日额度、余额、认证或人工停用事件才会让游标移到下一槽位：`key-05 → key-04 → key-03 → key-02 → key-01 → key-05`。余额、认证和人工停用状态在显式恢复前保持不可用。
3. 同一次逻辑调用最多获取每个可用槽位一次；一轮尝试完毕后有界停止。下一次独立调用会从持久化游标开始新的一轮有界探测。
4. 可信的未来 `reset_at` 会让日额度耗尽槽位在到期前保持不可用；如果上游没有给出可信 reset，该槽位允许在以后绕回时重新探测，不需要猜刷新时间或人工恢复。
5. QPS cooldown、并发错误、超时、网络故障、响应过大、上游 5xx 和未知错误都不会移动游标，也不会连续烧掉 Key 池。
6. 发生轮换、轮换失败或整个池不可用时，Agent 会收到脱敏提示，但不会看到 Key 或底层基础设施细节。

这是由明确事件驱动的环形 failover，不是逐请求 round-robin 负载均衡，也不能用于规避万得的账户、合同或服务限制。只能把你依法有权共同使用的 Key 放进同一个池。

`gateway/src/key-pool/slots.ts` 是唯一的非敏感 catalog、layout 与 generation 声明。slot identity 与 binding 保持稳定；priority 是由持久化 layout 派生的运行时 topology，不是 identity 或全局编号排序。未来普通扩容只追加 catalog binding，再把获批的新 block 插入**实际持久化 cursor 之前**并原子成为新 cursor；旧 effective ring 顺序完整保留。替换 binding 只需更新原 binding 并 restore 原 slot；重排、删除、改名或非 cursor-relative successor block 必须创建新的 generation 并蓝绿切换。当前发行版不会自动发现未声明的 Secret。单纯扩大 KeyPool 不会改变 MCP 地址、31 工具清单、OAuth 流程、管理 URL 形式或 Skill 包。

普通未来追加严格采用两阶段：先发布 **expand candidate**，让代码认识新 catalog、Secret binding 与 candidate layout，但 active layout 不变；再发布 **activate candidate**，切换到该 prefix-compatible layout。激活后只能回滚到已认识该 layout 的 expand candidate 或更高版本。完整 runbook 见[运维说明](docs/operations.md)。

## 前置条件

你需要准备：

- 可以使用对应 MCP 服务的万得 AIFin 账户或数据权限。
- 五枚万得 API Key，对应当前仓库 active primary layout；绝对不能把它们提交进仓库。
- 一个自己的 Cloudflare 账户，并启用 Workers、KV、Durable Objects、Cron Triggers，以及经过你确认的 Access/OIDC 应用。
- Git、npm 和 Node.js `>=24.13.1`。
- 一个支持 MCP 的 Agent 或客户端，用来连接部署后的服务。

Cloudflare、万得、身份服务和 AI 平台各自可能产生的费用或限制，由对应服务决定，不包含在这个仓库里。

## 推荐：先安装 Cloudflare Plugin

如果你希望 ChatGPT 或 Codex 帮你创建和维护 Cloudflare 资源，建议在开始部署前安装 Cloudflare 官方 Plugin：

1. 打开 [OpenAI 官方 Plugin 目录](https://developers.openai.com/plugins)，搜索 **Cloudflare**，安装后完成 Cloudflare OAuth。
2. 授权前仔细检查它申请的 Cloudflare 权限。
3. 要求 Agent 在修改任何资源前，先阅读本仓库的[安装指引](docs/installation.md)和[安全边界](docs/security.md)。

Cloudflare 还在采用 Apache-2.0 许可证的 [cloudflare/skills](https://github.com/cloudflare/skills) 仓库中公开维护可复用 Skills：

```bash
npx skills add https://github.com/cloudflare/skills
```

OpenAI 分发的 Plugin 打包结构可以在 [openai/plugins › cloudflare](https://github.com/openai/plugins/tree/main/plugins/cloudflare) 查看。这些公开仓库包含 Plugin/Skill 指令和连接配置；它们连接的 Cloudflare API MCP 托管服务是另一项远程服务，不能因为 Plugin 包开源就假定其服务端实现也包含在仓库里。

如果使用 Agent 辅助部署，推荐安装这个 Plugin；但 iWind 网关部署完成后，运行时并不依赖它。具备经验的维护者也可以直接按 Wrangler runbook 操作。

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/Rainnystone/iwind-connector.git
cd iwind-connector
npm ci
```

### 2. 准备私有万得 Key

在仓库外创建一个私有 env 文件。本项目的本地约定路径是 `../.secrets/iwind.keys.env`：

```dotenv
WIND_API_KEY_01=替换为第一枚Key
WIND_API_KEY_02=替换为第二枚Key
WIND_API_KEY_03=替换为第三枚Key
WIND_API_KEY_04=替换为第四枚Key
WIND_API_KEY_05=替换为第五枚Key
```

把文件权限限制为只有你自己可以读取。不要把真实值粘贴到源码、Markdown、聊天、截图、命令参数或部署 JSON 中。

Cloudflare 部署还需要 `gateway/wrangler.jsonc` 中 `secrets.required` 列出的 Secret binding。它们的值必须通过受保护的输入方式提供，不能把仓库里的安全占位值替换成生产值。

经批准的部署必须使用[安装说明](docs/installation.md)中的完整 owner-only Cloudflare Secret 文件：已存在的 Worker 先 `versions upload` 一个未部署 candidate，再以同一 rendered config 运行 exact `versions view <candidate> --config dist/wrangler.deploy.jsonc --json` 的 names-only inspection，最后用同一 config 显式 exact `@100%` 部署；首次创建才用一次完整 `deploy --secrets-file`。不要逐项使用 `secret put`，因为它会立即部署一个 version。

### 3. 验证代码

在仓库根目录运行：

```bash
npm test
npm run typecheck
npm run lint
npm run contract:verify
npm run build
```

`npm run build` 只是 Wrangler dry run，不会部署；但它可能清理共享的 `dist/` 目录，所以一定要在 build 之后再打包 Skill：

```bash
npm run skill:package
npm run secret:scan -- --secrets-file '../.secrets/iwind.keys.env'
```

最终生成：

```text
dist/iwind-aifin-connector-skill.zip
```

### 4. 部署到你自己的 Cloudflare

严格按照 [docs/installation.md](docs/installation.md) 操作。它会引导你：

- 创建或选择 OAuth KV namespace；
- 在不修改源码占位值的前提下生成部署专用 Wrangler 配置；
- 通过受保护输入提供所有必要 Secret；
- 检查 Worker、Durable Object、KV、cron、公开域名和 OAuth 设置；
- 在单独批准正式部署前先做 dry run；
- 验证 OAuth、31 个只读工具、一次代表性查询和 KeyPool 状态。

如果由 Agent 协助，可以先发送：

> 阅读 `README.zh-CN.md`、`docs/installation.md` 和 `docs/security.md`。先用非技术语言告诉我需要哪些 Cloudflare 资源和 Secret binding。在你列出准确计划并得到我批准前，不要创建、修改或部署任何资源。

部署会修改真实的外部基础设施。批准前请确认 Cloudflare 目标账户、资源名称、OAuth policy、公开域名和可能产生的服务费用。

### 5. 连接 Agent

所有平台都使用同一个 Skill zip 和同一个已部署 OAuth MCP 地址：

- [ChatGPT Work](adapters/chatgpt-work/README.md)：先把已部署的 `/mcp` 注册为 OAuth 自定义 Plugin，再单独上传 Skill zip。
- [Grok Web](adapters/grok-web/README.md)：按照当前产品界面注册 OAuth MCP Connector，并安装同一个 Skill 包。
- [本地客户端](adapters/local/README.md)：安装 Skill 包，再根据提供的 MCP 配置示例适配你的客户端。

Skill 不会自动安装或授权 MCP；MCP 连接也不会自动安装 Skill。云端环境需要分别完成这两个步骤。

### 6. 做一次只读 smoke test

先用一个已知、标准的 Wind code 做简单快照查询，并确认：

- 客户端调用的是 iWind MCP，而不是 Web Search；
- 选择的工具与数据类型匹配；
- 调用严格串行；
- 日期、单位、空值和数据覆盖范围得到保留；
- 普通成功没有运维警告；
- 回答中没有凭据或原始诊断信息。

如果只有公司名或不确定的代码，Skill 应该先搜索身份，再验证公司、标准 Wind code 和市场，最后才能调用属性或行情工具。

## 运维与维护

- [运维手册](docs/operations.md)：查看 KeyPool、替换/增加/禁用/恢复 Key，或刷新万得 schema snapshot。
- [故障排查](docs/troubleshooting.md)：解释稳定的 OAuth、网关、KeyPool 和万得错误码。
- [安全边界](docs/security.md)：Secret 管理、日志 allowlist、打包扫描和发布门禁。
- [验收清单](docs/acceptance-checklist.md)：完整的已验证范围和仍需平台实测的边界。

不要为了临时运维方便而改变 KeyPool 数量、轮换语义、OAuth policy、公开地址、工具 schema 或只读范围。这些属于架构修改，需要重新实现和审查。

## 仓库结构

```text
skill/                 运行时中立的 Agent Skill、references 和 evals
gateway/               Cloudflare Worker OAuth MCP 网关
adapters/              ChatGPT Work、Grok Web 和本地安装说明
scripts/               打包、验证、Secret 扫描和部署配置生成脚本
docs/                  安装、运维、安全、故障排查和验收文档
dist/                  生成且不进入 Git 的发布产物
```

Skill 包在固定的 `iwind-aifin-connector/` 根目录下只包含 `SKILL.md`、`references/*.md` 和 `evals/*.json`。它不包含端点、万得 Key、OAuth 凭据、网关代码、平台 metadata 或复制的工具 schema。

## 当前验证状态

仓库具备自动化的 unit、integration、五槽 cursor-relative 轮换、严格串行、打包、Secret 扫描和 dry-run build 测试。历史 production 证据不是 v0.6 `ring-primary-v2` 已完成部署的证据；Cloudflare rollout 仍需要单独批准。

ChatGPT Work 的自定义 Plugin 注册、OAuth、工具发现和代表性查询已经验证；最终 Skill 上传、Skill 自动触发和 scheduled task 仍属于账户级验收。Grok Web adapter 已提供，但尚未在真实 Grok 账户中验证。最新边界以[验收清单](docs/acceptance-checklist.md)为准。

## 仓库许可证与数据访问边界

交付仓库的代码和文档不含 Secret，并按可审计要求维护。但这不代表已经部署的网关是公共数据服务，也不包含、授予或授权重新分发任何万得数据访问权限。每位部署者都必须使用自己的 Cloudflare 账户、身份配置、万得数据权限和私有 API Key。

这个仓库目前没有 `LICENSE` 文件。源码可获得或可访问本身并不等于授予通用的开源复用许可，因此在正式添加许可证前，不应把它描述为已经按某个许可证开源。建议在鼓励重新分发或接受第三方贡献前，先选择并添加合适的许可证。

如果你 fork、部署或重新分发这个项目：

- 不要提交凭据、OAuth artifact、账户标识、私有部署记录、带临时参数的 callback URL 或业务响应；
- 使用自己的私有 Key 文件运行完整测试、确定性打包和精确 Secret 扫描；
- 在重新分发生成的契约信息或向其他人提供服务前，检查你与万得之间的协议；
- 除非新的安全边界经过明确设计、授权、实现和审查，否则始终保持网关只读。

Wind 和 iWind 相关产品名称属于其权利人。本仓库是独立的集成项目，与万得不存在隶属关系，也未获得万得背书；它不提供、转售或授予任何万得数据访问权限。
