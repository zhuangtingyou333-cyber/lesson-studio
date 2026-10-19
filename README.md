# 课间 · Lesson Studio

原生微信小程序与 TypeScript 后端的个人项目源码展示。面向课时制工作室，
管理员、老师和家长共用一个小程序；React 网页用于开发调试。

**Development snapshot, with synthetic demo data.** 本仓库没有生产凭据、真实学员数据，
也未包含正式微信支付、生产登录或已上线产品的证明。项目使用 Codex 等 AI 编程工具辅助开发。

## 技术与实现

- TypeScript、NestJS/Express、Zod；前后端共享类型。
- PostgreSQL 风格 SQL、迁移、PGlite 本地数据库与事务。
- 原生微信小程序（WXML/WXSS/TypeScript）与 React/Vite 开发界面。
- 排课冲突校验、周期排课、预约并发、幂等请求与事务回滚。
- 管理员/老师/家长的机构及数据权限；邀请核对、成员撤权。
- 点名与课时账本、请假补课、批量导入及课酬结算。

## 快速开始

需要 Node.js 24.15+、pnpm 11，以及可选的微信开发者工具。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm dev:tools
```

API 默认监听 `127.0.0.1:4310`；内部网页由 Vite 启动。
数据库保存在本地 `.data/studio`，空库首次启动只写入合成体验数据。
退出开发进程后可保留该目录，但不要提交它。

微信开发者工具导入 `dist/miniapp`，使用工具测试号。源码位于 `apps/miniapp`：

```sh
pnpm build:miniapp
```

手机上的 `127.0.0.1` 指手机自身，本地开发配置不等于真机联通。
正式服务还需要 HTTPS、真实身份与权限加固、监控及平台审核。
`check:miniapp` 额外依赖本机微信编译器，可通过 `WCC_PATH`、`WCSC_PATH` 配置。

## 阅读代码

| 路径 | 内容 |
|---|---|
| `apps/api/service.ts` | 业务命令、校验与事务协调 |
| `apps/api/identity.ts` | 会话、邀请与角色隔离 |
| `apps/api/scheduling.ts` | 周期日期与排课规则 |
| `apps/api/accounting.ts` | 课时与账本计算 |
| `apps/api/imports/` | CSV/Excel 解析及导入事务 |
| `apps/api/migrations/` | 可重复应用的数据库迁移 |
| `apps/api/tests/` | 并发、幂等、越权、回滚与客户端集成检查 |
| `apps/miniapp/` | 原生页面及 API 客户端 |
| `apps/admin-web/` | 内部开发界面 |
| `packages/contracts/` | 共享接口与数据类型 |

## 验证与来源

验证结果见 [VALIDATION.md](VALIDATION.md)。测试与种子中的姓名、联系方式、机构、
金额和身份均为合成案例，未从私人数据库导出。
本项目使用的第三方依赖列在 `package.json`、`pnpm-lock.yaml`，不随仓库复制依赖源码。
源码展示范围与权利说明见 [NOTICE.md](NOTICE.md)。
