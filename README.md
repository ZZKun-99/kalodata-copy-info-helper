# kalodata商品详情页-复制信息-脚本猫脚本

> **项目名**：kalodata商品详情页-复制信息-脚本猫脚本
> **GitHub 仓库名**：`kalodata-product-split-scriptcat`（GitHub 仓库名只支持英文字母、数字和 `- _ .`，中文项目名保留在这里与仓库简介中）
> **脚本文件**：`kalodata-product-split.user.js` · 版本 `2.5.0` · 作者 `zz`

在 [Kalodata](https://www.kalodata.com) 商品详情页（`/product`）的一侧「切」出一块可自由拖拽的预留区：网页本体按收窄后的宽度排版，空出来的一侧放自建的商品中文翻译卡片，两边逐行滚动对齐。支持关键词高亮、点选商品、**一键复制中文名**，以及把选中的商品导出成排版固定的 Excel。

脚本内部 `@name` 为「Kalodata 商品页分区布局 · 网页 1560 + 固定预留区」，是单个 `.user.js` 文件、零第三方依赖的用户脚本。

## 主要功能

| 模块 | 说明 |
| --- | --- |
| 分区布局 | 以「1920 屏 → 网页 1560 + 预留区 360」为基准自动算宽度；预留区可拖拽分隔线、可点顶栏数字直接输入，默认在左侧、`Alt+X` 一键换边 |
| 收起 / 恢复 | 拖到 200px 以下自动收起，整页宽度原样恢复；收起后留一条迷你停靠条，`Alt+Z` 随时展开 |
| 宽度伪装 | `@run-at document-start` 阶段先快照原生 getter，再改写 `innerWidth` / `clientWidth` / `visualViewport`，让站点表格按收窄后的宽度排版而不是被响应式挤压 |
| 商品翻译卡 | 卡片与页面表格逐行滚动对齐；调用站点自身翻译接口补齐中文名，结果缓存在 `localStorage` |
| **复制信息** | 点卡片上的中文名即复制到剪贴板（优先 Clipboard API，被权限拦下自动回退到 `textarea` 方案） |
| 关键词与高亮 | 搜索框回车即存为高亮词，点词条可一键勾选 / 取消所有命中商品，命中的文字在卡片里高亮 |
| Excel 导出 | 脚本内自实现 ZIP + XLSX 打包，**不依赖任何外部库**；固定列宽与行高、内嵌商品图片，22 个基础列 + 9 个可选扩展列，还能把多份已导出的 xlsx 合并成一份 |
| 设置面板 | 面板底色透明度、导出扩展列开关、网页优化开关（缩略图省内存 / 拦广告像素 / 拦站点埋点 / 列表跟随），以及「复位预留区宽度」 |
| SPA 路由感知 | 站点是前端路由，脚本在进入 / 离开 `/product` 时自动收回或恢复面板，不会把面板留在别的页面上 |

快捷键：`Alt+Z` 收起 / 展开预留区，`Alt+X` 左右换边。宽度、位置、开关、透明度、高亮词库与翻译缓存都存浏览器 `localStorage`，刷新后保留。

## 安装

1. 浏览器安装 **脚本猫 ScriptCat**（推荐，浏览器扩展商店搜索即可），Tampermonkey / Violentmonkey 同样兼容。
2. 把本仓库的 `kalodata-product-split.user.js` 拖进扩展的「安装 / 新建脚本」页面，或复制全文粘贴到新建脚本里保存。
3. 打开 `https://www.kalodata.com/product`，页面一侧出现预留区面板即安装成功。

> 需要已登录 Kalodata 账号。脚本用 `@grant none` 运行在页面上下文，不使用任何 `GM_*` 特权 API，因此无需额外授权；翻译功能复用你当前的浏览器会话。

## 生效范围与元数据

| 项 | 值 |
| --- | --- |
| `@match` | `https://www.kalodata.com/product`、`https://www.kalodata.com/product/` |
| `@run-at` | `document-start` |
| `@grant` | `none` |
| `@noframes` | 是 |
| 目标站点 | Kalodata 商品详情页（脚本内再做一次主机名 + 路径校验） |

## 使用小贴士

- 顶栏那个宽度数字可以直接点开输入；双击分隔线复位到公式值。
- 页面表格渲染慢时，脚本会在 0.6s / 1.5s / 3.2s / 6s / 10s / 15s 有限次补读，也可以点顶栏的刷新按钮手动重读。
- 没读到商品行时，先确认页面停在「商品榜」视图，再点「重新读取」。
- 控制台提供调试接口 `KDP_SPLIT`：`state`、`set({side, panelW, alpha})`、`reset()`、`exportPlan`、`merge([File, File])`、`remeasure()`、`refresh()`。
- 需要安静的控制台时，把脚本顶部 `CONFIG.DEBUG` 改为 `false`。

## 实现说明

整个脚本是一个 IIFE，自底向上分层，同层只调用它上面的层：配置与路由门 → 通用工具 → 原生读数探针 → 布局计算 → 状态仓库 → 样式层 → 宽度伪装层 → Shadow DOM 视图层 → 控制器 → 业务层（采集 / 翻译 / XLSX 打包）→ 展示层。

UI 全部装在一个 Shadow Root 里，与站点 CSS 完全隔离；尺寸只通过 CSS 变量驱动，拖动时只改变量、不重写样式表，浏览器会把同一帧的多次写入合并成一次布局计算，所以不会闪动。状态走单一数据源 + 订阅广播，视图只负责渲染。

### 关于网络行为（公开说明）

- **翻译**：会向站点自身的 `https://www.kalodata.com/v1/translation/translate` 发送商品标题（`credentials: 'include'` 复用当前登录会话），换取中文名。**不会向任何第三方服务器发送页面数据**。
- **请求拦截**：会包裹 `fetch` / `XMLHttpRequest` / `sendBeacon` / 图片与 script 标签的 `src`，按域名清单拦掉第三方广告与监控像素（Twitter / Bing / 百度 / 热图等，默认开启）；站点自家埋点上报默认**关闭**，两者都能在设置面板单独开关。匹配只做域名后缀判断，不碰鉴权与风控接口，业务请求原样放行。
- **列表跟随**：被动读取 `/product/queryList`、`/product/searchList` 的响应体，用于让卡片与表格同步；不改写请求、不转发数据。
- 脚本**不读取、不保存**账号密码、Cookie 或 Token；本仓库内也没有任何硬编码凭据。

## 注意事项与免责声明

- 本脚本仅用于提升个人浏览与整理效率，依赖第三方站点的页面结构、DOM 与接口；站点改版后可能部分或全部失效。
- 请遵守 Kalodata 的服务条款及适用法律法规，导出的数据请勿用于未经授权的商业用途或再分发。
- 本项目与 Kalodata 官方无任何关联，仅供学习交流。

## 目录

```
kalodata-product-split-scriptcat/
├── kalodata-product-split.user.js   # 脚本本体，直接用它安装
├── README.md                        # 本文档
└── .gitignore
```
