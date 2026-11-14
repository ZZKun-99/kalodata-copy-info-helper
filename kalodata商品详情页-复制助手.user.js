// ==UserScript==
// @name         kalodata商品详情页-复制助手
// @name:zh-CN   kalodata商品详情页-复制助手
// @namespace    workbuddy/kalodata-split
// @version      1.0.1
// @description  在 document-start 伪造窗口宽度，把 kalodata 商品详情页固定住，另一侧留出自建面板：卖点/属性点击即复制（容量类只复制数字）、SKU 左半格复制容量（没容量则转红并复制价格）右半格复制价格、好评点吐槽点自动翻译（观点标题居左、占比居右，两者各自点击即复制；1~4 星在行首用极小数字标出，5 星不动）、一键跳转视频与评价、一键打开商品描述弹窗、自动把「更多」点成「收起」、顺手截断把页面拖到 40 秒的第三方广告埋点、面板底色可调透明度（文字始终不透明）、记住收起/展开与左右位置、评价分析未解锁就不拉接口（可在设置里强制）、顺带修掉站点图片预览关闭后留下的全屏隐形遮罩。
// @author       zz
// @match        https://www.kalodata.com/product/detail*
// @include      /^https?:\/\/(www\.)?kalodata\.com\/product\/detail(\?.*)?$/
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  文件结构（严格按“底层 → 上层”排列，每一层只依赖它上面的层）
 * ═══════════════════════════════════════════════════════════════════════════
 *    §0  配置常量        所有可调参数集中在这一处
 *    §0.5 路由门          唯一入口闸：URL 没有 ?id= 就整体不启动（最先执行）
 *    §0.6 网络闸          拦掉第三方广告/埋点（它们把 load 从 1.5s 拖到 40s），一次性改写
 *    §0.7 区域表          什么 URL 跑哪段代码；离开详情页自动收回，回来自动恢复
 *    §1  通用工具        纯函数，零副作用，可复用
 *    §2  原生读数探针    必须最先执行：在任何伪装之前抓住原生 getter
 *    §3  布局计算        纯函数：真实宽度 → 分区方案（可单测）。规则只有一条：宿主多宽由你定
 *                        （默认 1400，可拖到 320~视口），剩下的全给面板，面板不设下限
 *    §4  状态仓库        单一数据源 + 订阅广播
 *    §5  样式层          唯一的 CSS 注入点，全部由 CSS 变量驱动
 *    §5.5 通栏 fixed 条      纯 CSS 按类名收窄，零 JS、零监听（见 §5 的 FIXED 段）
 *    §5.6 站点浮层层级      纯 CSS 把 antd 弹层抬到面板之上，零 JS（见 §5 的 FLOAT 段）
 *    §5.7 预览遮罩修复      纯 CSS 补上 zoom 离场时长，让 rc-motion 能正常卸载
 *    §6  伪装层          改写宽度读数（innerWidth / clientWidth / visualViewport）
 *    §7  视图层          预留区面板 / 分隔线 / 迷你停靠条
 *    §8  控制器          装配、事件绑定、持久化
 *    §9  启动
 *
 *  ═══ 以下分区是 v0.6 起的功能路线图，实现时按编号往下追加，不要插进上面 ═══
 *
 *    §10 定位表          所有选择器 / XPath / API 路径集中于此 —— debug 界面改的就是它
 *    §11.0 评价解锁门    只读页面判断评论是否已解锁；没解锁就不打接口
 *    §11 采集层          纯读取：attrs / skus / reviews，产出标准数据结构，不碰 DOM 样式
 *    §12 等待器          有限时窗的 waitFor（拿到即停，超时即止，绝不常驻）
 *    §13 复制层          统一剪贴板入口 + 视觉反馈
 *    §14 功能·收起        把页面上所有「更多」点成「收起」
 *    §15 功能·跳转        点站点原生页签 → 等它自己滚完 → 补一个固定像素（不看文字）
 *    §15.5 功能·描述      点页面上的「商品描述」入口，弹窗交给站点自己渲染
 *    §16 视图·卡片        面板内的区块渲染（快捷复制 / SKU 左右半格 / 评论）
 *    §16.2 本栏内跳转    顶部/好评点/吐槽点：只滚自己的 .scroll，不碰页面
 *    §17 视图·设置        展示界面 ⇄ 设置界面（互斥）：分组表单 + 原始 JSON + 提示词
 *
 *  各分区的依赖方向严格单向：§16/§17 只能调用 §11/§13/§15，不能反向。
 *  所有「怎么定位一个元素」的知识只允许写在 §10，其余地方禁止硬编码选择器。
 *
 *  为什么是 document-start + grant none
 *    · document-start：抢在 React / echarts / 埋点 SDK 之前执行，
 *      此时改 innerWidth 才不会被页面先读到。
 *    · grant none：脚本直接跑在页面上下文，Object.defineProperty(window,...)
 *      才对页面真实生效；带 GM_* 授权会进沙箱，改的是沙箱 window。
 *
 *  站点事实（2026-11 实测）
 *    · 根容器 .product-detail-page 自带 min-w-[1280px]；宿主默认 1400，允许被拖窄到 320
 *      （压到 1280 以下时站点自己出横向滚动 —— 面板宽度优先于站点排版）
 *    · 主体是 mx-auto max-w-[1680px] 流式布局，容器变窄会自动回流，无需 Hack 内部组件
 *    · window.innerWidth = 1924，但 documentElement.clientWidth = 1912（12px 滚动条）
 *      → 必须按 clientWidth 计算，否则边界会差出十几像素压在分隔线上
 *    · 页面 DOMContentLoaded 约 0.36s，但 load 要 39.7s —— 全部卡在 Twitter 广告像素上；
 *      截断后 load 回到 1.1~1.5s（见 §0.6）
 * ═══════════════════════════════════════════════════════════════════════════
 */

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════════
   * §0  配置
   * ═══════════════════════════════════════════════════════════════════════ */

  const CONFIG = {
    // —— 尺寸约束 ——
    // 站点自己带 min-w-[1280px]，低于它 kalodata 内容会横溢 —— 但那是「站点的事」，
    // 不是「面板的事」：面板宽度优先，宿主允许被压到 HOST_FLOOR，压窄后站点自己出横向滚动。
    // 所以这里没有「预留区最小宽度」这种东西，只有一条：别把宿主拖成一条缝。
    HOST_FLOOR: 320,        // 宿主可拖到的最窄宽度
    DEFAULT_HOST_W: 1400,   // 默认宽度 / 双击复位 / 拖动吸附的落点
    SNAP_RADIUS: 14,        // 吸附半径（px）

    // —— 行为默认值 ——
    DEFAULT_SIDE: 'left', // 预留区默认在左侧：'left' | 'right'

    // —— 外观 ——
    // 面板「底色」的不透明度：只作用于面板 / 顶栏 / 卡片 / 输入框这些“面”，
    // 文字颜色一律不受影响（不收 alpha、不加 opacity），所以调到 35% 字还是清的。
    // 用途：页面有东西漏到面板背后时，降低不透明度就能看见它。
    UI: {
      ALPHA: 1,          // 默认全不透明；设置界面里可调
      ALPHA_MIN: 35,     // 滑块下限（%）
      ALPHA_MAX: 100
    },

    // —— 稳定性开关 ——
    // 设计原则：所有「限制宽度」的动作都发生在注入的那一瞬间（一条 <style> + 几个 getter），
    // 之后不再做任何自动补偿、不监听 DOM 变动、不做轮询。
    // 「position:fixed 通栏条按类名钉进宿主矩形」这条规则是纯 CSS（元素插入即生效），
    // 从 v0.6.1 起固定开启，不再提供开关 —— 关掉它只会让吸顶栏被面板盖住，没有第二个人会想要那种效果。

    // —— 路由门：只有「详情页 + 带 id 参数」才算匹配 ——
    // @match 无法约束 query，所以必须在脚本里再判一次：
    //   https://www.kalodata.com/product/detail?id=xxxx   ✅ 启动
    //   https://www.kalodata.com/product/detail           ❌ 不启动（无 id）
    //   https://www.kalodata.com/product                  ❌ 不启动（列表页）
    ROUTE: {
      path: '/product/detail',   // 精确路径（忽略末尾斜杠）
      param: 'id',               // 必须存在且非空的 query 参数
      allowHosts: ['www.kalodata.com', 'kalodata.com']
    },

    // —— 功能层参数（v0.6）——
    FEATURE: {
      AUTO_COLLAPSE: true,     // 启动时把「更多」点成「收起」（被动功能，设置里可关）
      REVIEW_FORCE: false,     // 评价分析没解锁时也照拉接口（默认关：只在页面上已经能看到评论时才采）
      REVIEW_PAGE_SIZE: 30,    // 每个观点取多少条（站点一页 10 条，30 = 前 3 页）
      REVIEW_GATE_WAIT: 3000,  // 判断「评论解锁没有」时最多等页面把评价区画出来多久（见 §11.0：正常加载时到点就不用等了）
      CONCURRENCY: 3,          // 评论请求并发上限，别一次全打出去
      API_TIMEOUT: 5000,       // 单个接口的超时上限（任何一个挂住都会让刷新入口整体哑掉，见 LOC.post）
      COLLECT_WAIT: 20000,     // 等页面把详情渲染出来的上限（拿到即停，超时即放弃）
      SKU_VISIBLE: 3,          // SKU 默认露出几条，其余收纳在「展开全部」后面（顺序 = 接口原始顺序 = 网页显示顺序）

      // —— 跳转（v0.6.4：借站点自己的滚动，末尾只补固定像素）——
      //   流程：点站点自己的页签 → 等它自己滚完（只读 scrollY）→ 查一次标题 → 落到「标题 + extra」。
      //   符号：正数 = 继续往下滚（标题往上走、被条压住更多）；负数 = 往回一点。
      //   实测参考（1400px 宿主 / 常驻条 209 / 标题高 28）：
      //     评价分析：+44 = 标题被条压掉 44（表头「观点·占比·客户原声·详情」正好贴条下沿，默认）
      //               +100 = 第一条观点贴条下沿
      //     视频与广告：0 = 「视频内容」表头被条压掉一半（默认）；-20 = 表头完整露在条下
      JUMP_EXTRA: { reviews: 44, video: 0 },
      JUMP_SETTLE_MIN: 140,       // 点完至少等这么久，才允许判断「站点滚完了」
      JUMP_SETTLE_QUIET: 90,      // 连续这么久 scrollY 没变 = 滚完了
      JUMP_SETTLE_MAX: 1200,      // 判断的硬上限，到点就按当前值算
      JUMP_GUARD: 420,            // 补完偏移后再观察这么久，被站点覆盖就补一次
      STICKY_FALLBACK: 209,       // 常驻条量不到时的兜底高度（实测 56 + 153）

      // —— 商品描述（v0.6.5：只负责「点一下页面上的那个入口」）——
      //   点完弹窗由站点自己渲染，我们不看 DOM、不等、不关。
      //   这 320ms 只是防连点：连点两下会让弹窗开→关，看起来像「点了没反应」。
      DESC_GUARD: 320
    },

    // —— 网络闸（v0.6.2）——
    // 只拦「对页面零用处、还会把 load 事件拖到几十秒」的第三方。
    // 白名单（死保，绝不进这张表）：www.kalodata.com 主站与接口、*.kalowave.cn 图片 CDN、
    // *.alicdn.com / *.portal101.cn / *.aliyuncs.com（阿里云验证码 + 设备指纹，拦了会触发风控）。
    NET: {
      ENABLED: true,               // 默认开（设置里可关；原型改写不可逆 → 改动下次加载生效）
      BLOCK: [
        't.co',                      // Twitter 广告点击像素（实测 27~37 秒才超时）
        'analytics.twitter.com',     // 同上，20 秒
        'static.ads-twitter.com',    // 上面那两个像素的加载器，拦掉它俩就不会被创建
        'bat.bing.com',              // Bing 广告 UET
        'clarity.ms',                // 微软 Clarity：会话录屏，会把整页 DOM 传上去
        'hm.baidu.com',              // 百度统计
        'sentry.io',                 // 前端错误上报
        'das.kalodata.com'           // 站点自己的埋点上报（/api/v1/collect），与功能无关
      ]
    },

    // —— 内部标识 ——
    STORAGE_KEY: 'kds-split-cfg',   // localStorage 键（side / hostW / 开关）
    LOC_KEY: 'kds-loc-override',    // 设置界面里改的定位覆盖（+ 跳转偏移）
    JUMP_VER_KEY: 'kds-jump-ver',   // JUMP 语义版本：老存档的偏移在新算法下方向相反，升级时丢弃一次
    STYLE_ID: 'kds-split-style',
    LAYER_ID: 'kds-split-layer',
    HTML_FLAG: 'data-kds-split',    // html 上的开关属性，'on' 时才生效
    DRAG_FLAG: 'data-kds-dragging', // 拖动态单独一个属性，绝不能和 HTML_FLAG 抢同一个值
    Z_INDEX: '2147483000',

    DEBUG: true
  };

  /**
   * 想「换浏览器 / 换电脑也带着同一套定位」时，把设置界面「复制配置」得到的 JSON
   * 原样粘到下面（替换 null），存成脚本文件里的一部分：
   *
   *   const LOC_EMBEDDED = { "T": {...}, "S": {...}, "API": {...}, "PRIORITY": [...], "JUMP": {...} };
   *
   * 优先级：内置默认 < LOC_EMBEDDED < localStorage 里的实时覆盖。
   * 也就是说：粘进来以后它就是新默认值，页面上再改还是存 localStorage，不会回写脚本文件
   * （油猴 / 脚本猫都写不了本地文件，见 §17 末尾的说明）。
   */
  const LOC_EMBEDDED = null;

  const SIDE = { LEFT: 'left', RIGHT: 'right' };
  const ACT = { SIDE: 'side', TOGGLE: 'toggle', VIEW: 'view', REFRESH: 'refresh' };
  const NAV = { VIDEO: 'video', REVIEWS: 'reviews', DESC: 'desc' };

  /* ═══════════════════════════════════════════════════════════════════════
   * §0.5  路由门
   *
   *  @match 只能约束 scheme / host / path，管不住 query。
   *  「/product/detail」这个路径在无 id 时是空壳页，跑分区没有意义，
   *  所以脚本自己要再判一次：pathname 命中 + ?id= 存在且非空，才继续。
   *
   *  不满足就 return：整个 IIFE 到此结束，不注入样式、不改任何 getter、
   *  不建任何定时器。页面与脚本之间零接触，等同于脚本没装。
   *
   *  代价（已知）：**启动**仍是一次性判断，不监听 URL。
   *  如果站点用前端路由从列表页点进详情页（不刷新），脚本不会自己醒来，需要刷新一次。
   *  「已经在详情页、后来又走了」这个方向由 §0.7 的区域哨兵负责（收回）；两个方向不对称，
   *  是因为前者要求脚本在**别的页面**也常驻待命，后者只要求它自己收拾干净。
   * ═══════════════════════════════════════════════════════════════════════ */

  const Gate = {
    /** 当前 URL 是否命中详情页（含 id 参数） */
    matches(href) {
      let url;
      try { url = new URL(href || location.href); } catch (e) { return false; }

      if (CONFIG.ROUTE.allowHosts.indexOf(url.hostname) === -1) return false;

      // 去掉末尾斜杠再比，避免 /detail/ 漏判
      const path = url.pathname.replace(/\/+$/, '');
      if (path !== CONFIG.ROUTE.path) return false;

      const value = url.searchParams.get(CONFIG.ROUTE.param);
      return !!(value && value.trim());
    },

    /** 从当前地址取出商品 id（后续所有采集/API 都要用它做 key） */
    productId() {
      try {
        return new URL(location.href).searchParams.get(CONFIG.ROUTE.param) || '';
      } catch (e) { return ''; }
    }
  };

  if (!Gate.matches()) {
    // 刻意留一行 console 而不是静默：debug 时能立刻分辨「没匹配」和「匹配了但崩了」。
    if (CONFIG.DEBUG) {
      console.info('[KDS] 路由未命中（需要 /product/detail + 非空 id），脚本不启动:', location.href);
    }
    return;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * §0.7  区域表 —— 「什么 URL 跑哪段代码」
   *
   *  上面那道门只管「启动时在不在详情页」。但站点是前端路由：
   *  从详情页点进别的页面**不会刷新文档**，面板会一直贴在屏幕上，
   *  宽度也一直收窄 —— 这就是「跳出去了还赖着」的那一幕。
   *
   *  所以这里把「区域」抽成一张表：一行 = 一个区域 = 一段独立的代码区域。
   *  现在只有 A（详情页）；以后要加 B（商品属性页）、C（排行榜），
   *  就往表里加一行、再在 switch 里挂一个 Attrs.start() / Rank.start()，
   *  不用碰详情页的任何一行代码。
   *
   *  Region.watch() 只挂一次监听（Navigation API 优先，退化为 popstate + 改写
   *  pushState/replaceState），回调只在「区域变了」时触发 —— 同区域内部换商品不会响，
   *  所以它不是轮询、也不会在页面上高频跑。
   * ═══════════════════════════════════════════════════════════════════════ */

  const REGIONS = [
    { key: 'detail', test: (href) => Gate.matches(href) }
    // { key: 'attrs', test: (href) => /\/product\/attrs/.test(href) },   ← 以后加一行
    // { key: 'rank',  test: (href) => /\/rank/.test(href) }
  ];

  const Region = {
    /** 当前 URL 属于哪个区域；一个都不匹配就返回 ''（= 不该有 UI） */
    current(href) {
      for (let i = 0; i < REGIONS.length; i += 1) {
        try { if (REGIONS[i].test(href || location.href)) return REGIONS[i].key; } catch (e) { /* 忽略 */ }
      }
      return '';
    },

    /** 同文档内的路由变化才回调一次；返回值是挂载时的区域 */
    watch(onChange) {
      let last = this.current();
      const fire = () => {
        const next = this.current();
        if (next === last) return;
        last = next;
        onChange(next);
      };

      const nav = window.navigation;
      if (nav && nav.addEventListener) {
        // 现代 Chrome/Edge：URL 提交后触发，不用改写 history
        nav.addEventListener('currententrychange', fire);
      } else {
        window.addEventListener('popstate', fire);
        ['pushState', 'replaceState'].forEach((name) => {
          const raw = history[name];
          history[name] = function () { const out = raw.apply(this, arguments); fire(); return out; };
        });
      }
      return last;
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * §0.6  网络闸 —— 砍掉「对页面零用处、却把 load 拖到几十秒」的第三方
   *
   *  实测（该商品页，本脚本其它部分不变）：
   *    DOMContentLoaded  0.36s ── kalodata 自己的接口全在 200ms 内
   *    load             39.7s ── 卡在 4 个 1×1 广告像素上
   *      t.co/1/i/adsct                    37.7s
   *      t.co/i/adsct                      27.7s
   *      analytics.twitter.com/1/i/adsct   20.3s
   *      analytics.twitter.com/i/adsct     20.3s
   *  这三个域名国内连不通，浏览器只能一直等 TCP 超时。标签页那个「转圈」就是
   *  load 事件还没结束 —— 跟 kalodata 的页面内容无关。
   *
   *  做法：在 document-start 把「发请求的出口」包一层，命中黑名单直接丢弃。
   *  一次性改写，之后没有任何监听 / 轮询 / 重试。
   *
   *  边界（都实测过）：
   *   · 只改 img.src / script.src / XHR / fetch / sendBeacon，**不改 setAttribute**
   *     —— 实验对比过，多改这一处收益为零（拦截点在广告脚本自身，脚本不跑就没人建像素）。
   *   · 原型改写不可逆 → 设置里的开关只对「下次加载」生效，改完刷一次即可。
   *   · 白名单死保（见 CONFIG.NET 注释）：主站、图片 CDN、验证码、风控指纹一律不碰。
   *   · 任何一步改写失败只跳过自己，不影响脚本其它部分。
   * ═══════════════════════════════════════════════════════════════════════ */

  const NetGuard = {
    hits: 0,        // 本次加载拦掉几个请求（只做展示，不参与逻辑）

    /**
     * 同步读开关。
     * 这里在 document-start 最前面，§1 的 Util 还没定义（TDZ），所以内联读一次。
     * 默认开；用户明确关过（存了 blockNet: false）才关。
     */
    enabled() {
      try {
        const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
        if (!raw) return CONFIG.NET.ENABLED;
        const saved = JSON.parse(raw);
        return !(saved && saved.blockNet === false);
      } catch (e) {
        return true;
      }
    },

    match(url) {
      if (!url) return false;
      let host = '';
      try { host = new URL(String(url), location.href).hostname; } catch (e) { return false; }
      for (let i = 0; i < CONFIG.NET.BLOCK.length; i += 1) {
        const domain = CONFIG.NET.BLOCK[i];
        if (host === domain || host.endsWith('.' + domain)) return true;
      }
      return false;
    },

    /** 命中就记一笔并返回 true */
    hit(url) {
      if (!this.match(url)) return false;
      this.hits += 1;
      return true;
    },

    install() {
      if (!this.enabled()) return false;
      const self = this;
      const blockedXhr = new WeakSet();   // 比往 xhr 上挂属性干净（不可枚举、不被页面遍历看到）
      let channels = 0;

      /* ① <img src> —— 广告像素本体：new Image().src = 'https://t.co/...' */
      try {
        const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        if (desc && desc.set) {
          Object.defineProperty(HTMLImageElement.prototype, 'src', {
            configurable: true,
            enumerable: desc.enumerable,
            get: desc.get,
            set(value) { if (!self.hit(value)) desc.set.call(this, value); }
          });
          channels += 1;
        }
      } catch (e) { /* 改不动就算了，别拖垮主流程 */ }

      /* ② <script src> —— 广告 / 埋点脚本本身（拦掉它，像素就没人创建了） */
      try {
        const desc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
        if (desc && desc.set) {
          Object.defineProperty(HTMLScriptElement.prototype, 'src', {
            configurable: true,
            enumerable: desc.enumerable,
            get: desc.get,
            set(value) { if (!self.hit(value)) desc.set.call(this, value); }
          });
          channels += 1;
        }
      } catch (e) { /* 同上 */ }

      /* ③ XHR —— Clarity 的 /collect 走这条 */
      try {
        const open = XMLHttpRequest.prototype.open;
        const send = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
          if (self.hit(url)) { blockedXhr.add(this); return undefined; }
          return open.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function () {
          if (blockedXhr.has(this)) return undefined;
          return send.apply(this, arguments);
        };
        channels += 1;
      } catch (e) { /* 同上 */ }

      /* ④ fetch */
      try {
        const rawFetch = window.fetch;
        if (typeof rawFetch === 'function') {
          window.fetch = function (input) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (self.hit(url)) {
              // 给一个「成功但是空的」响应，调用方 await 之后拿到空 body，不会抛错
              return Promise.resolve(new Response('', { status: 204 }));
            }
            return rawFetch.apply(this, arguments);
          };
          channels += 1;
        }
      } catch (e) { /* 同上 */ }

      /* ⑤ sendBeacon —— 页面关闭前的最后一批埋点 */
      try {
        const beacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
        if (beacon) {
          navigator.sendBeacon = function (url, data) {
            if (self.hit(url)) return true;
            return beacon(url, data);
          };
          channels += 1;
        }
      } catch (e) { /* 同上 */ }

      if (CONFIG.DEBUG && channels) {
        console.info('[KDS] 网络闸已装 ' + channels + ' 条通道，黑名单 ' + CONFIG.NET.BLOCK.length + ' 个域');
      }
      return channels > 0;
    }
  };

  NetGuard.install();

  /* ═══════════════════════════════════════════════════════════════════════
   * §1  通用工具（纯函数）
   * ═══════════════════════════════════════════════════════════════════════ */

  const Util = {
    clamp(value, min, max) {
      return Math.max(min, Math.min(max, value));
    },

    /**
     * 透明度（0~1）统一夹取。上下限只有 CONFIG.UI.ALPHA_MIN / ALPHA_MAX 一处来源。
     * 以前三个地方各写一个数（0.05 / 35% / 35%），语义容易对不上，这里收成一个入口。
     */
    clampAlpha(value) {
      const max = CONFIG.UI.ALPHA_MAX / 100;
      const num = typeof value === 'number' && isFinite(value) ? value : max;
      return this.clamp(num, CONFIG.UI.ALPHA_MIN / 100, max);
    },

    /**
     * 星级归一化 → 1~5 的整数。认不出来的一律当 5。
     *
     * 接口给的 rating 是字符串（实测 "5.0" / "3.0" / "2.0"），不是数字，
     * 所以不能直接拿去比较 —— 这里统一 parseFloat + 四舍五入。
     * 兜底成 5 是有意的：5 星是默认样式（什么都不画），认错时宁可「少标」也不要「错标」。
     */
    star(raw) {
      const value = Math.round(parseFloat(String(raw).replace(/[^\d.]/g, '')));
      if (!isFinite(value) || value <= 0) return 5;
      return value > 5 ? 5 : value;
    },

    /**
     * 观点占比 → 展示 / 复制用的文本，认不出来返回 ''（宁可不显示，也不显示 "NaN%"）。
     *
     * 接口实测返回的是**字符串**："74.62%" / "50.0%" / "12.5%"。
     * 所以先看有没有百分号；万一哪天改成 0.7462 这种小数，就按「小于等于 1 当比例」换算。
     * "50.0%" 这种尾巴上的 .0 顺手抹掉，复制出去更像人话。
     */
    rateText(raw) {
      if (raw == null || raw === '') return '';
      if (typeof raw === 'number' && isFinite(raw)) {
        const pct = (raw > 0 && raw <= 1) ? raw * 100 : raw;
        return (Math.round(pct * 100) / 100) + '%';
      }
      const text = String(raw).trim();
      if (!text) return '';
      if (text.indexOf('%') >= 0) return text.replace(/\.0+%$/, '%');
      const value = parseFloat(text);
      if (!isFinite(value)) return '';
      const pct = (value > 0 && value <= 1) ? value * 100 : value;
      return (Math.round(pct * 100) / 100) + '%';
    },

    /** 在规定的时间窗口内最多执行一次 */
    debounce(fn, wait) {
      let timer = null;
      const wrapped = function (...args) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; fn.apply(this, args); }, wait);
      };
      wrapped.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
      return wrapped;
    },

    /** 安全读取 localStorage 里的 JSON 对象 */
    readJSON(key) {
      try {
        const raw = localStorage.getItem(key);
        const value = raw ? JSON.parse(raw) : null;
        return value && typeof value === 'object' ? value : null;
      } catch (e) {
        return null;
      }
    },

    writeJSON(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 隐身模式等场景忽略 */ }
    },

    removeKey(key) {
      try { localStorage.removeItem(key); } catch (e) {}
    },

    log(...args) {
      if (CONFIG.DEBUG) console.log('%c[KDS-SPLIT]', 'color:#0369a1;font-weight:600', ...args);
    },

    /**
     * 文本归一化：去掉空白 + 不可见字符。
     *
     * 为什么必须去掉私用区字符（U+E000–U+F8FF）：
     * 站点按钮里那个下拉箭头是「图标字体」，不是 svg —— 「更多」按钮的 textContent
     * 实际是 "更多" + U+E620。不过这一关，`textContent === '更多'` 永远不成立，
     * 看起来完全正常的按钮就是匹配不到（这个坑排查了很久）。
     */
    norm(text) {
      return (text || '')
        .replace(/[\u200B-\u200F\u2060\uFE00-\uFE0F\uE000-\uF8FF]/g, '')
        .replace(/\s+/g, '');
    },

    /**
     * 按 XPath 取**第一个**节点，取不到 / 表达式非法都返回 null。
     *
     * 为什么单独开一个入口：站点有个「商品描述」入口，它是纯 React 按钮，
     * 类名一改再改（flex cursor-pointer items-center gap-1 py-1 text-sm …），
     * 页面上又没有独一无二的文案可当锚点（「商品描述」这四个字在其它地方也出现）。
     * 这种情况下 XPath 反而更稳：它只依赖层级，不依赖类名。
     * 代价是站点改结构就失效 —— 所以在 §10 里它是「X 组」，与 T / S 并列，可随时被配置覆盖。
     */
    byXPath(path) {
      if (!path) return null;
      try {
        const found = document.evaluate(
          path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return found.singleNodeValue || null;
      } catch (e) {
        return null;
      }
    },

    /**
     * 限定并发的批量任务。tasks 是「返回 Promise 的函数」数组，结果顺序与输入一致。
     * 用在这里是为了别把 12 个评论请求同时打出去（顺序无关，但顺序要可预期）。
     */
    async poolMap(tasks, limit) {
      const results = new Array(tasks.length);
      let cursor = 0;
      const size = Math.max(1, Math.min(limit || 3, tasks.length));
      const worker = async () => {
        while (cursor < tasks.length) {
          const index = cursor++;
          try { results[index] = await tasks[index](); }
          catch (e) { results[index] = null; }
        }
      };
      await Promise.all(new Array(size).fill(0).map(worker));
      return results;
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * §2  原生读数探针
   *    必须在 §6 定义任何 getter 之前完成快照，否则读到的就是被伪装后的值。
   * ═══════════════════════════════════════════════════════════════════════ */

  const NativeProbe = (() => {
    const descriptorOf = (proto, prop) => {
      try { return Object.getOwnPropertyDescriptor(proto, prop); } catch (e) { return null; }
    };

    // 快照：调用时绕开我们自己的覆盖，永远拿到浏览器真实值
    const innerWidthDesc = descriptorOf(window, 'innerWidth');
    const clientWidthDesc = descriptorOf(Element.prototype, 'clientWidth');

    const call = (desc, target, fallback) => {
      try {
        if (desc && typeof desc.get === 'function') return desc.get.call(target);
        return fallback();
      } catch (e) {
        return fallback();
      }
    };

    return {
      innerWidth() {
        return call(innerWidthDesc, window, () => window.innerWidth || 0) || 0;
      },
      /** 元素真实 clientWidth（不受我们在 documentElement 上的覆盖影响） */
      clientWidth(element) {
        return call(clientWidthDesc, element, () => element.clientWidth || 0) || 0;
      }
    };
  })();

  /* ── 滚动条宽度测量（结果缓存，避免反复插 DOM） ─────────────────────
   * 只用一个 position:fixed 的离屏探针量一次；它不参与文档流，
   * 不会引起页面重排 —— 这一点很关键，见下方 measureLayoutWidth 的注释。
   */
  const Scrollbar = {
    width: -1,
    dpr: 0,

    measure() {
      const de = document.documentElement;
      if (!de) return 0;
      const probe = document.createElement('div');
      probe.setAttribute('data-kds-probe', '');
      probe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:100px;height:100px;' +
        'overflow:scroll;visibility:hidden;pointer-events:none;';
      de.appendChild(probe);
      const width = probe.offsetWidth - probe.clientWidth;
      probe.remove();
      return width > 0 ? width : 0;
    },

    get() {
      const dpr = window.devicePixelRatio || 1;
      if (this.width < 0 || this.dpr !== dpr) {   // 浏览器缩放会改变滚动条像素宽度
        this.width = this.measure();
        this.dpr = dpr;
      }
      return this.width;
    }
  };

  /**
   * 真实可用宽度 = 视口里实际能用来排版的那一条宽度。
   *
   * 为什么不能直接读 innerWidth：
   *   实测这台机器上 innerWidth = 1924，而 documentElement.clientWidth = 1912，
   *   恒定差 12px（非 100% 缩放 + 经典滚动条）。拿 1924 去算 2/3，宿主会多出 12px
   *   压在分隔线上（早期版本实测确实切掉了“收费套餐”按钮的一半），拖动时边界也恒偏 12px。
   *
   * 为什么不能靠 html.scrollHeight 判断有没有滚动条：
   *   kalodata 的滚动发生在内部容器里，<html> 自己既不滚动、也没有滚动条，
   *   但这个滚动条确实占掉了视口的 12px。判据不成立。
   *
   * 采用的测法：
   *   插一个 position:fixed 的 1px 探针，它的包含块是初始包含块（视口），
   *   width:100% 得到的就是「视口可用宽度」——已经扣掉经典滚动条，带不做任何重排
   *   （fixed 元素脱离文档流）。量完立刻移除。
   *
   * 绝对不能用的测法：
   *   「临时把 <html> 宽度改回 auto 再读 clientWidth」。那会让整页重排一次，而站点图表用
   *   ResizeObserver 观察尺寸并转派 window.resize，于是「测量 → 重排 → resize → 测量」
   *   形成死循环，把渲染进程跑满（实测会把页面卡死）。
   */
  const Viewport = {
    /** 探针：返回视口可用宽度（布局像素，不含经典滚动条），拿不到返回 0 */
    measure() {
      const de = document.documentElement;
      if (!de) return 0;
      const probe = document.createElement('div');
      probe.setAttribute('data-kds-probe', '');
      probe.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:1px;' +
        'visibility:hidden;pointer-events:none;';
      de.appendChild(probe);
      let width = 0;
      try {
        // 必须用 offsetWidth，不能用 getBoundingClientRect().width：
        // 页面被缩放过（Ctrl+/- 或浏览器放大）时，gBCR 返回的是「视觉像素」，
        // 实测 1924；而 offsetWidth 是不受缩放变换影响的布局像素，实测 1912，
        // 与 documentElement.clientWidth 完全一致 —— 这才是真正能拿来排版的宽度。
        width = probe.offsetWidth || probe.getBoundingClientRect().width || 0;
      } finally {
        probe.remove();
      }
      return width > 400 ? Math.round(width) : 0;
    }
  };

  function measureLayoutWidth() {
    const innerWidth = NativeProbe.innerWidth();

    // ① 探针优先：唯一能绕开「缩放 + 滚动条」两个干扰的直读值。
    //    交叉校验一次：结果必须不超过 innerWidth、且不能小太多。
    //    （若站点给 <html> 加了 transform/filter，fixed 的包含块会退化成 <html>，
    //      探针会量到被我们收窄后的宿主宽度 —— 这种异常值必须拒绝，否则预留区会归零。）
    const probed = Viewport.measure();
    if (probed > 400 && (!(innerWidth > 400) ||
        (probed <= innerWidth + 1 && probed >= innerWidth - 40))) {
      return probed;
    }

    // ② 兜底：innerWidth 扣掉实测滚动条宽度（量不到就按典型值 17 扣）
    if (innerWidth > 400) {
      const scrollbarW = Scrollbar.get() || 17;
      return Math.round(innerWidth - scrollbarW);
    }

    return 1920;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * §3  布局计算（纯函数，无 DOM、无副作用）
   * ═══════════════════════════════════════════════════════════════════════ */

  const Layout = {
    /**
     * 唯一的规则：宿主占多宽，剩下的全给预留区。
     * 只做物理夹取（不宽过视口、不窄到没有），**不给预留区设下限** ——
     * 面板想拖多窄就多窄，站点因此横溢是用户明确接受过的代价。
     *
     * @returns {{realW:number,hostW:number,reserveW:number,canSplit:boolean}}
     */
    compute(realW, options) {
      const opts = options || {};
      const wanted = typeof opts.userHostW === 'number' && isFinite(opts.userHostW)
        ? opts.userHostW
        : CONFIG.DEFAULT_HOST_W;

      const hostW = Math.round(Util.clamp(wanted, Math.min(CONFIG.HOST_FLOOR, realW), realW));
      const reserveW = Math.max(0, Math.round(realW - hostW));

      return {
        realW,
        hostW,
        reserveW,
        canSplit: reserveW > 0
      };
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * §4  状态仓库（单一数据源）
   * ═══════════════════════════════════════════════════════════════════════ */

  const Store = {
    state: {
      realW: 0,             // 真实排版视口宽度
      hostW: CONFIG.DEFAULT_HOST_W, // 伪装给页面的宽度 / kalodata 实际占用宽度
      reserveW: 0,          // 预留区宽度
      side: CONFIG.DEFAULT_SIDE,
      enabled: true,        // 分区是否开启（= 预留区是否可见）
      userHostW: null,      // 用户拖拽后的固定宿主宽度；null = 跟随 DEFAULT_HOST_W
      canSplit: true,       // 当前窗口是否还有地方给预留区（reserveW === 0 时为 false）
      view: 'show',         // 'show' 展示界面 | 'debug' 设置界面（互斥）
      alpha: CONFIG.UI.ALPHA,                       // 面板底色不透明度（0.35~1），文字恒定不透明
      autoCollapse: CONFIG.FEATURE.AUTO_COLLAPSE,  // 自动把「更多」点成「收起」
      forceReviews: CONFIG.FEATURE.REVIEW_FORCE,   // 评价未解锁也采集（默认关）
      blockNet: CONFIG.NET.ENABLED                 // 截断第三方广告/埋点（下次加载生效）
    },

    listeners: [],

    subscribe(fn) {
      this.listeners.push(fn);
      return () => {
        const index = this.listeners.indexOf(fn);
        if (index >= 0) this.listeners.splice(index, 1);
      };
    },

    /** 合并状态并广播（广播只做视图更新，不做重计算，避免环） */
    patch(partial) {
      let changed = false;
      for (const key in partial) {
        if (Object.prototype.hasOwnProperty.call(partial, key) && this.state[key] !== partial[key]) {
          this.state[key] = partial[key];
          changed = true;
        }
      }
      if (changed) this.listeners.forEach((fn) => fn(this.state));
      return changed;
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * §5  样式层（唯一 CSS 注入点）
   *    所有尺寸都走 CSS 变量，拖动时只改变量、不重写样式表，
   *    避免每帧重新解析 CSS 造成卡顿/闪动。
   * ═══════════════════════════════════════════════════════════════════════ */

  const StyleLayer = {
    element: null,

    ensure() {
      if (this.element && this.element.isConnected) return this.element;
      let style = document.getElementById(CONFIG.STYLE_ID);
      if (!style) {
        const hostEl = document.head || document.documentElement;
        if (!hostEl) return null;         // 极早期还没有 <html>
        style = document.createElement('style');
        style.id = CONFIG.STYLE_ID;
        hostEl.appendChild(style);
      }
      this.element = style;
      return style;
    },

    /** 注入固定规则：只在 html[data-kds-split="on"] 下生效，关闭时页面天然复原 */
    install() {
      const style = this.ensure();
      if (!style) return;
      const flag = `html[${CONFIG.HTML_FLAG}="on"]`;

      const rules = [
        /* —— 宿主排版盒：整页收窄到 --kds-host-w —— */
        `${flag}{`,
        `  width:var(--kds-host-w, ${CONFIG.DEFAULT_HOST_W}px) !important;`,
        `  max-width:var(--kds-host-w, ${CONFIG.DEFAULT_HOST_W}px) !important;`,
        `  min-width:0 !important;`,
        `  margin-left:var(--kds-gap, 0px) !important;`,
        `  overflow-x:hidden !important;`,
        `}`,
        /* —— body 同步，避免子元素按 body 自然宽度撑开 —— */
        `${flag} body{`,
        `  width:var(--kds-host-w, ${CONFIG.DEFAULT_HOST_W}px) !important;`,
        `  max-width:var(--kds-host-w, ${CONFIG.DEFAULT_HOST_W}px) !important;`,
        `  overflow-x:hidden !important;`,
        `}`,
        /* —— 站点根容器自带 min-w-[1280px]，钉死成宿主宽度 —— */
        `${flag} .product-detail-page{`,
        `  width:var(--kds-host-w, ${CONFIG.DEFAULT_HOST_W}px) !important;`,
        `  max-width:var(--kds-host-w, ${CONFIG.DEFAULT_HOST_W}px) !important;`,
        `}`,
        /* —— 拖动时全局锁光标，鼠标划过任何元素都保持左右箭头 —— */
        `html[${CONFIG.DRAG_FLAG}] *{`,
        `  cursor:col-resize !important;`,
        `  user-select:none !important;`,
        `}`
      ];

      /* —— position:fixed 的通栏条（吸顶 header、底部操作条）——
       * 这类元素按「视口」定位，html 收窄对它们无效，会按全视口宽度排版。
       * 这里用纯 CSS 按类名约定直接钉进宿主矩形 [gap, gap+hostW]：
       *   · [class~="fixed"]  精确匹配 Tailwind 的 position:fixed 工具类
       *   · 再叠加通栏标记 inset-x-0 / w-full / !fixed，把范围收窄到「整条」
       * 全部是静态规则，元素一插入就生效，没有 JS、没有时序、没有监听。 */
      const fits = [
        `${flag} [class~="fixed"][class*="inset-x-0"]`,
        `${flag} [class~="fixed"][class*="w-full"]`,
        `${flag} [class*="!fixed"][class*="w-full"]`
      ].join(',\n');
      rules.push(
        fits + '{',
        `  left:var(--kds-gap, 0px) !important;`,
        `  right:auto !important;`,
        `  width:var(--kds-host-w, ${CONFIG.DEFAULT_HOST_W}px) !important;`,
        `  max-width:var(--kds-host-w, ${CONFIG.DEFAULT_HOST_W}px) !important;`,
        `  min-width:0 !important;`,
        `}`
      );

      /* —— §5.6 站点浮层的层级（纯 CSS，见下方长注释）——
       * antd 的弹层/下拉/气泡都是 body 级的 absolute，坐标按「真实视口」算；
       * 而我们把整页右移了一个 gap，于是「靠左弹出」的浮层会正好落进面板所占的
       * x∈[0, gap) 那块区域，被 z-index 极高的面板整个盖住（语言/货币选择框就是这样丢的）。
       * 这里只把这几个「瞬态浮层」抬到面板之上：元素一插入即生效，零 JS、零监听。
       * modal 不动 —— 遮罩若压到面板上面，面板会变暗且点不动，那是另一种坏。 */
      const floats = [
        '.ant-popover', '.ant-dropdown', '.ant-select-dropdown',
        '.ant-picker-dropdown', '.ant-tooltip', '.ant-message', '.ant-notification'
      ].map((sel) => `${flag} ${sel}`).join(',\n');
      rules.push(
        floats + '{',
        `  z-index:${Number(CONFIG.Z_INDEX) + 1} !important;`,
        `}`
      );

      /* —— §5.6b 居中弹窗的「居中坐标系」——
       * 现象：好评点/吐槽点点「详情」弹出的评价明细，左边一截被面板盖住。
       *
       * 成因：antd 的 .ant-modal-wrap.ant-modal-centered 是 display:block + text-align:center，
       * 内层 .ant-modal 是 inline-block —— 它按**真实视口**（0 ~ 真实宽度）居中，
       * 而页面内容已经被我们右移了 gap，于是弹窗中线落在整屏中线上，
       * 左边自然伸进 x∈[0, reserve) 的预留区，被 z-index 极高的面板压住（实测 471 < 513）。
       *
       * 改法：给 wrap 补一条预留侧的 padding —— 它的内容盒变成 [gap, 真实宽度)，
       * 居中就发生在页面实际可用区里，弹窗自己回到内容区，面板也不用降层级。
       * 纯 CSS + CSS 变量：开/关、左边/右边、拖动宽度都是变量一变就跟着变，
       * 零 JS、零监听、零时序。只碰 centered 这一类（其余模态按 body 定位，本来就不越界）。 */
      rules.push(
        `${flag} .ant-modal-wrap.ant-modal-centered{`,
        `  padding-left:var(--kds-gap, 0px) !important;`,
        `  padding-right:var(--kds-gap-r, 0px) !important;`,
        `}`
      );

      /* —— §5.6c Radix 浮层（下拉 / 气泡 / 提示）——
       * 现象：点「过去30天」这类下拉，选项弹到页面左边、钻进预留区被面板盖住。
       *
       * 成因：这些浮层是 Radix 的 `[data-radix-popper-content-wrapper]`，挂在 body 上、
       * position:fixed，坐标用 `transform: translate(x, y)` 写死；它的 x 是
       * 「锚点位置 − 包含块左边界」算出来的，而 html 被我们 margin-left 推了 gap，
       * 于是每次都少算 gap（实测 x=87.5，实际应该 600.5；z-index 只有 50，
       * 比面板的 2147483000 低，所以不是「被压住」而是「画错地方 + 层次不够」）。
       *
       * 改法：一条 margin-left 把 gap 补回去（fixed 元素的 margin 就是位移）。
       * 全站只有这一种浮层实现，规则统一生效；右置/收起时 --kds-gap 为 0，天然无副作用。
       * 纯 CSS、零 JS、零监听，和 §5.6b 同一个思路：不降面板层级，只把浮层挪回内容区。 */
      rules.push(
        `${flag} [data-radix-popper-content-wrapper]{`,
        `  margin-left:var(--kds-gap, 0px) !important;`,
        `}`
      );

      /* —— §5.7 图片预览的「隐形遮罩」（与分区开关无关，永远生效）——
       * 现象：点 SKU 图片 → 开放大预览 → 关掉之后整页点不动、滚不动，但内容照常显示。
       *
       * 成因（在 9222 上实测）：站点主题把 antd 的 zoom 离场动画时长写成了 0
       *   .ant-zoom-leave { animation-duration: 0; animation-play-state: paused }
       * 而 rc-motion 是靠 animationend 判断「离场播完了」才去卸载 DOM 的。
       * 时长 0 → 事件根本不会派发 → 组件永远停在 ant-zoom-leave-active，
       * 留下一个 z-index 1101、pointer-events:auto、内容透明（内层 opacity:0）的
       * 全屏 div.ant-image-preview-wrap —— 就是那面看不见的墙。
       *
       * 所以只补两条 CSS，零 JS、零监听、不改任何别的样式：
       *   ① 给「离场」一个真实时长 → 事件按时到达 → rc-motion 自己把节点摘掉（治因）
       *   ② 兜底：万一还是残留（关预览时页面正好在后台、动画帧被节流），
       *      让「正在离场」的那层不吃指针 → 页面照常可点可滚（治症）
       * 进场动画、站点其它交互一概不动。 */
      rules.push(
        '.ant-zoom-leave.ant-zoom-leave-active{',
        '  animation-duration:.2s !important;',
        '}',
        '.ant-image-preview-wrap:has(.ant-image-preview.ant-zoom-leave){',
        '  pointer-events:none !important;',
        '}'
      );

      style.textContent = rules.join('\n');
    },

    /** 只改变量：一次 style 变更，浏览器合并成一次布局计算 */
    setMetrics(hostW, reserveW, gapLeft, gapRight) {
      const de = document.documentElement;
      if (!de) return;
      const right = typeof gapRight === 'number' ? gapRight : 0;
      const key = hostW + '|' + reserveW + '|' + gapLeft + '|' + right;
      if (key === this.lastMetrics) return;   // 值没变就别碰样式，避免触发无意义的重排
      this.lastMetrics = key;
      de.style.setProperty('--kds-host-w', hostW + 'px');
      de.style.setProperty('--kds-reserve-w', reserveW + 'px');
      de.style.setProperty('--kds-gap', gapLeft + 'px');
      de.style.setProperty('--kds-gap-r', right + 'px');
    },

    /**
     * 面板「面」的不透明度（0.05~1）。
     * 只写一个 CSS 变量 --kds-a：面板底色 / 顶栏 / 卡片 / 输入框都是
     * rgba(..., var(--kds-a))，文字颜色是写死的 hex，永远不受影响。
     */
    setAlpha(alpha) {
      const de = document.documentElement;
      if (!de) return;
      // 下限只认 CONFIG.UI.ALPHA_MIN 一处（以前这里是 0.05、滑块是 35%，两套口径）
      const value = Util.clampAlpha(alpha);
      if (value === this.lastAlpha) return;
      this.lastAlpha = value;
      de.style.setProperty('--kds-a', String(value));
    },

    /** 分区开关：on 才应用上面的所有规则；off 时页面完全回到原样 */
    setEnabled(enabled) {
      const de = document.documentElement;
      if (!de) return;
      if (enabled) de.setAttribute(CONFIG.HTML_FLAG, 'on');
      else de.removeAttribute(CONFIG.HTML_FLAG);
    },

    setDragging(dragging) {
      const de = document.documentElement;
      if (!de) return;
      if (dragging) de.setAttribute(CONFIG.DRAG_FLAG, '');
      else de.removeAttribute(CONFIG.DRAG_FLAG);
    },

  };

  /* ═══════════════════════════════════════════════════════════════════════
   * §5.5 关于 position:fixed 组件（静态处理，无任何监听）
   *
   * position:fixed 的定位基准是「视口（初始包含块）」，把 <html> 收窄对它无效，
   * 所以站点里 inset-x-0 的吸顶栏仍会按全视口宽度排版。
   *
   * 早期版本用一个模块去「扫描 → 打标 → 再扫描」，那带来了两个你不想要的特性：
   *   · 常驻 MutationObserver + scroll 监听（页面每次 DOM 变动都要跑一遍）
   *   · 元素挂载到打标之间的时间差，表现为滚动时闪一下全宽
   *
   * 现在改为纯 CSS：直接按站点的类名约定写死几条规则（见 §5 的 FIT_CSS 段），
   * 元素一插入就生效，零 JS、零时序、零监听。
   * 代价是「依赖类名」——站点改版后可能失效；但失效的表现只是那条通栏
   * 保持全宽、被左侧面板盖住，不会循环、不会重试、不会影响页面其他部分。
   * ═══════════════════════════════════════════════════════════════════════ */

  /* ═══════════════════════════════════════════════════════════════════════
   * §5.6 站点浮层为什么会“消失”（纯 CSS 抬高，无任何监听）
   *
   * 现象：面板在左侧时，页头国家的下拉里，「语言 / 货币」点开的列表看不见。
   *
   * 实测（1400 宿主 / gap 513 / 视口 1912）：
   *   语言行           x = 1028..1112（贴着宿主右边）
   *   语言弹层         x = 232..494   ← 落在面板 0..513 里，被面板整个盖住
   *   弹层 style       inset: auto 1419px …  即「贴在触发元素左边」
   *
   * 为什么会选「左边」：antd 弹层按 视口坐标 判空位，左边剩余 1028px、
   * 右边只剩 1912-1112=… 而它读到的视口宽度被我们伪装成 1400，于是右边只剩 288px，
   * 左边「显得」更宽 —— 它算的左边那块地，其实是我们面板占的 gap。
   * 这不是「右边有空所以被推过去」，正相反：是 gap 被当成了页面的空白。
   *
   * 所以这题没法用「把页面再收窄一点」解决 —— 收窄只会让 gap 更大。
   * 在不引入 JS 的前提下，只有两条路：
   *   ① 把面板放到右边（Alt+X）：gap=0，坐标与视口重合，弹层自然回到页面里；
   *   ② 允许这类「瞬态浮层」画在面板之上（见 §5 的 FLOAT 段）：
   *      antd 的 popover / dropdown / select-dropdown / tooltip 统一抬到面板之上。
   *      代价是弹层展开时会盖住面板一小块，收起即恢复。
   * modal 刻意不抬：遮罩若压到面板上，面板会变暗且点不动。
   * ═══════════════════════════════════════════════════════════════════════ */

  /* ═══════════════════════════════════════════════════════════════════════
   * §6  伪装层（宽度读数）
   *    关闭分区时必须返回真实值 —— 这是“Alt+Z 隐藏后面板宽度不恢复”的病根。
   * ═══════════════════════════════════════════════════════════════════════ */

  const Spoofer = {
    installed: false,

    /** 当前应该对外报告的宽度 */
    reportedWidth() {
      return Store.state.enabled ? Store.state.hostW : NativeProbe.innerWidth();
    },

    defineGetter(target, prop, getter) {
      if (!target) return;
      try {
        Object.defineProperty(target, prop, { configurable: true, enumerable: true, get: getter });
      } catch (e) { /* 个别属性不可重定义，忽略 */ }
    },

    /** window 级伪装：不需要 DOM，document-created 阶段即可安装 */
    installWindow() {
      if (this.installed) return;
      this.installed = true;

      const width = () => this.reportedWidth();
      this.defineGetter(window, 'innerWidth', width);
      this.defineGetter(window, 'outerWidth', width);

      const vv = window.visualViewport;
      if (vv) {
        this.defineGetter(vv, 'width', width);
        this.defineGetter(vv, 'offsetLeft', () => 0);
      }
    },

    /** 元素级伪装：必须在元素出现后补。关闭分区时返回元素真实值，不能虚报。 */
    installDocument() {
      const de = document.documentElement;
      if (!de) return;
      this.defineGetter(de, 'clientWidth', () =>
        Store.state.enabled ? Store.state.hostW : NativeProbe.clientWidth(de));
    },

    installBody() {
      const body = document.body;
      if (!body) return;
      this.defineGetter(body, 'clientWidth', () =>
        Store.state.enabled ? Store.state.hostW : NativeProbe.clientWidth(body));
      // 注意：不要覆盖 scrollWidth —— 它在 getter 里读自己会无限递归，
      // 而且布局收窄后它本来就是对的，没有伪装的必要。
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * §7  视图层
   *   全部 UI 装在一个 shadow root 里：
   *   · 与站点 CSS 完全隔离，不用跟 kalodata 的选择器打架
   *   · 一个 fixed 全屏容器 + pointer-events 分层，不挡页面点击
   * ═══════════════════════════════════════════════════════════════════════ */

  /* ---------- §7.0 视图公共：模板与样式 ---------- */

  const VIEW_CSS = `
    *,*::before,*::after{box-sizing:border-box}

    .layer{
      position:absolute;inset:0;
      font:13px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
      color:#334155;
      pointer-events:none;              /* 只让具体控件接管点击 */
    }

    /* ---------- 预留区面板 ---------- */
    .panel{
      position:absolute;top:0;bottom:0;
      display:flex;flex-direction:column;
      /* 只有“面”带 alpha；里面的文字颜色是写死的 hex，永远不透明 */
      background:rgba(248,250,252,var(--kds-a,1));
      pointer-events:auto;
      overflow:hidden;
    }
    .panel[data-side="left"]{
      left:0;width:var(--kds-reserve-w,0px);
      border-right:1px solid rgba(203,213,225,var(--kds-a,1));
    }
    .panel[data-side="right"]{
      left:var(--kds-host-w,1400px);right:0;
      border-left:1px solid rgba(203,213,225,var(--kds-a,1));
    }
    .panel[hidden]{display:none}

    .panel-head{
      flex:0 0 auto;height:40px;
      display:flex;align-items:center;gap:8px;
      padding:0 8px 0 10px;
      background:rgba(255,255,255,var(--kds-a,1));border-bottom:1px solid rgba(226,232,240,var(--kds-a,1));
    }
    .panel-title{display:flex;align-items:center;gap:6px;font-weight:600;color:#0f172a;white-space:nowrap}
    .panel-title .dot{width:6px;height:6px;border-radius:50%;background:#3b82f6;flex:0 0 auto}
    .panel-meta{
      margin-left:auto;display:flex;align-items:center;gap:6px;
      color:#94a3b8;font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;
    }
    .panel-meta b{color:#475569;font-weight:600}

    /* 顶栏那个可编辑的宽度数字 */
    .meta-num{
      width:52px;padding:1px 4px;margin:0;
      border:1px solid transparent;border-radius:4px;
      background:transparent;color:#475569;font:inherit;font-weight:600;
      font-variant-numeric:tabular-nums;text-align:right;
      pointer-events:auto;outline:none;cursor:text;
      transition:background .12s,border-color .12s,box-shadow .12s;
    }
    .meta-num:hover{background:#f1f5f9;border-color:#e2e8f0}
    .meta-num:focus{
      background:#fff;border-color:#3b82f6;color:#0f172a;
      box-shadow:0 0 0 2px rgba(59,130,246,.18);
    }
    .panel-actions{display:flex;align-items:center;gap:2px;margin-left:2px}

    .icon-btn{
      width:26px;height:26px;padding:0;border:0;border-radius:6px;
      display:flex;align-items:center;justify-content:center;
      background:transparent;color:#64748b;cursor:pointer;
      transition:background .12s,color .12s;
    }
    .icon-btn:hover{background:#f1f5f9;color:#0f172a}
    .icon-btn:active{background:#e2e8f0}
    .icon-btn svg{width:15px;height:15px;display:block}

    .panel-body{flex:1 1 auto;min-height:0;padding:0;overflow:hidden;display:flex;flex-direction:column}
    .stat{display:flex;justify-content:space-between;gap:8px;color:#64748b;font-size:12px}
    .stat i{font-style:normal;color:#0f172a;font-variant-numeric:tabular-nums}
    .hint{
      padding:10px;border-radius:8px;background:rgba(255,255,255,var(--kds-a,1));
      border:1px dashed rgba(203,213,225,var(--kds-a,1));color:#94a3b8;font-size:12px;line-height:1.7;
    }
    .hint code{
      font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
      background:rgba(241,245,249,var(--kds-a,1));border:1px solid rgba(226,232,240,var(--kds-a,1));border-radius:4px;
      padding:0 4px;font-size:11px;color:#475569;
    }

    /* ---------- 分隔线（拖拽手柄） ---------- */
    .divider{
      position:absolute;top:0;bottom:0;width:13px;
      cursor:col-resize;pointer-events:auto;
      display:flex;align-items:center;justify-content:center;
      touch-action:none;
    }
    .divider[data-side="left"]{left:calc(var(--kds-reserve-w,0px) - 6px)}
    .divider[data-side="right"]{left:calc(var(--kds-host-w,1400px) - 6px)}
    .divider[hidden]{display:none}

    .divider .line{
      width:2px;height:100%;border-radius:2px;
      background:transparent;transition:background .14s;
    }
    .divider .grip{
      position:absolute;width:6px;height:40px;border-radius:99px;
      background:#94a3b8;box-shadow:0 0 0 3px rgba(255,255,255,.85);
      opacity:0;transition:opacity .14s,background .14s,height .14s;
    }
    .divider:hover .line{background:rgba(59,130,246,.55)}
    .divider:hover .grip{opacity:1;background:#3b82f6}
    .divider.snap .line{background:rgba(34,197,94,.6)}
    .divider.snap .grip{opacity:1;background:#22c55e;height:56px}
    .divider.dragging .line{background:rgba(59,130,246,.8)}
    /* 吸附时绿色优先（放在 dragging 之后，特异性也更高） */
    .divider.dragging.snap .line{background:rgba(34,197,94,.9)}

    /* ---------- 拖动气泡 ---------- */
    .bubble{
      position:absolute;top:50%;transform:translate(-50%,-50%);
      padding:5px 10px;border-radius:8px;
      background:rgba(15,23,42,.9);color:#fff;
      font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;
      pointer-events:none;opacity:0;transition:opacity .12s;
    }
    .bubble.show{opacity:1}
    .bubble.snap{background:rgba(22,163,74,.95)}

    /* ---------- 隐藏后的迷你停靠条（也是恢复入口，必须能被看见） ---------- */
    .mini{
      position:fixed;top:50%;transform:translateY(-50%);
      display:flex;flex-direction:column;gap:2px;
      padding:4px 3px;border-radius:9px;
      background:rgba(255,255,255,var(--kds-a,1));
      border:1px solid rgba(203,213,225,var(--kds-a,1));
      box-shadow:0 3px 12px rgba(15,23,42,.14);
      pointer-events:auto;
      opacity:.92;transition:opacity .15s,box-shadow .15s;
      z-index:1;
    }
    .mini::after{
      content:"";position:absolute;top:8px;right:-3px;width:5px;height:5px;
      border-radius:50%;background:#3b82f6;
    }
    .mini[data-side="left"]{left:6px}
    .mini[data-side="left"]::after{right:auto;left:-3px}
    .mini[data-side="right"]{right:6px;left:auto}
    .mini:hover{opacity:1;box-shadow:0 4px 16px rgba(15,23,42,.2)}
    .mini[hidden]{display:none}
    .mini button{
      width:22px;height:22px;border:0;border-radius:5px;background:transparent;
      color:#475569;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;
    }
    .mini button:hover{background:#eff6ff;color:#1d4ed8}
    .mini button svg{width:14px;height:14px;display:block}

    /* ═══════════ v0.6 面板正文 ═══════════ */

    .view{display:none;flex:1 1 auto;min-height:0;flex-direction:column}
    .view.on{display:flex}
    .cards{display:flex;flex-direction:column;gap:8px}

    /* 可滚动区：跳转条留在外面，永远不动 */
    .scroll{
      flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;
      padding:0 10px 0;display:flex;flex-direction:column;gap:8px;
    }

    /* 跳转条：上行三个入口（评价分析 / 视频与广告 / 商品描述），永远钉在面板顶部；
       下行三个「本栏内跳转」，只有上行一半高、间隔更窄，尽量少占正文高度 */
    .navbar{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px 5px;flex:0 0 auto;padding:10px 10px 6px}
    .nav-btn{
      display:flex;align-items:center;justify-content:center;gap:4px;min-width:0;
      height:30px;padding:0 4px;
      border:1px solid rgba(219,227,236,var(--kds-a,1));border-radius:7px;background:rgba(255,255,255,var(--kds-a,1));
      color:#475569;font:600 12px/1 system-ui,sans-serif;cursor:pointer;
      transition:background .12s,border-color .12s,color .12s;
    }
    /* 面板被拖窄时靠省略号收尾，绝不让文字顶出按钮 */
    .nav-btn span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .nav-btn:hover{background:#eff6ff;border-color:#bfdbfe;color:#1d4ed8}
    .nav-btn:active{background:#dbeafe}
    .nav-btn svg{width:13px;height:13px;flex:0 0 auto}
    /* 下行小按钮：纯文字、半高 */
    .nav-btn.sub{height:20px;font-size:11px;font-weight:600;color:#64748b;border-radius:5px;gap:0}
    .nav-btn.sub:hover{color:#1d4ed8;background:#f8fafc}

    /* 卡片 */
    .card{
      background:rgba(255,255,255,var(--kds-a,1));border:1px solid rgba(229,234,241,var(--kds-a,1));border-radius:9px;
      padding:8px 9px;display:flex;flex-direction:column;gap:6px;
    }
    .card-head{
      display:flex;align-items:center;gap:6px;
      font-size:11px;font-weight:700;color:#64748b;letter-spacing:.03em;
    }
    .card-head .n{font-weight:500;color:#cbd5e1;font-variant-numeric:tabular-nums}
    .card-head .sp{margin-left:auto}
    .card-empty{color:#cbd5e1;font-size:11.5px;text-align:center;padding:8px 0}
    .card-err{color:#dc2626;font-size:11px;line-height:1.5;word-break:break-all}

    /* 卖点芯片 */
    .chips{display:flex;flex-wrap:wrap;gap:4px}
    .chip{
      display:inline-flex;align-items:center;height:24px;padding:0 9px;
      border-radius:99px;background:rgba(239,246,255,var(--kds-a,1));border:1px solid rgba(219,234,254,var(--kds-a,1));color:#1d4ed8;
      font-size:12px;line-height:1;cursor:pointer;user-select:none;
      transition:background .12s,border-color .12s,transform .08s;
    }
    .chip:hover{background:#dbeafe;border-color:#bfdbfe}
    .chip:active{transform:scale(.96)}

    /* 属性行：值可点 */
    .attr{display:flex;gap:8px;font-size:12px;line-height:1.55;align-items:flex-start}
    .attr .k{flex:0 0 56px;color:#94a3b8;padding-top:1px;white-space:nowrap}
    .attr .v{
      flex:1 1 auto;min-width:0;color:#0f172a;cursor:pointer;
      padding:0 4px;margin:0 -4px;border-radius:4px;word-break:break-word;
      transition:background .12s,box-shadow .12s;
    }
    .attr .v:hover{background:#eff6ff;box-shadow:inset 0 0 0 1px #bfdbfe}
    .attr .v.prio{font-weight:600}

    /* SKU 行：左右各 50% 的点击区（严格对半，不按字宽）
       左 = 容量（蓝）；名字里没容量时左半转红，改为复制价格。
       右 = 价格（红，跟价格数字同色）。
       点击区是盖在内容上面的两个透明块，所以点缩略图、点名字、点价格
       都只看「落在哪一半」，与点到了哪个元素无关。 */
    .sku{
      position:relative;
      display:flex;align-items:center;gap:8px;
      padding:5px 6px;margin:0 -6px;border-radius:6px;
      cursor:pointer;
    }
    .sku:not(:last-child){border-bottom:1px dashed rgba(238,242,247,var(--kds-a,1))}
    .sku .half{
      position:absolute;top:0;bottom:0;width:50%;
      border-radius:6px;transition:background .1s;
    }
    .sku .half.l{left:0;background:rgba(59,130,246,.055)}
    .sku .half.r{left:50%;background:rgba(220,38,38,.032)}
    .sku .half.l:hover{background:rgba(59,130,246,.16)}
    .sku .half.r:hover{background:rgba(220,38,38,.14)}
    /* 名字里没容量：左半改红（= 它也复制价格），跟右半同色但互不合并 */
    .sku .half.l.alt{background:rgba(220,38,38,.032)}
    .sku .half.l.alt:hover{background:rgba(220,38,38,.14)}
    .sku .thumb{
      width:30px;height:30px;flex:0 0 auto;border-radius:5px;overflow:hidden;
      background:rgba(241,245,249,var(--kds-a,1));display:block;
    }
    .sku .thumb img{width:100%;height:100%;object-fit:cover;display:block}
    .sku .thumb.ph{display:flex;align-items:center;justify-content:center;color:#cbd5e1;font-size:9px}
    .sku .nm{
      flex:1 1 auto;min-width:0;font-size:11.5px;color:#334155;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    }
    .sku .pr{
      flex:0 0 auto;font-size:12px;font-weight:700;color:#b91c1c;
      padding:2px 5px;border-radius:5px;font-variant-numeric:tabular-nums;
      transition:background .12s;
    }
    /* SKU 收纳：展开 / 收起（纯文字按钮，不抢视觉） */
    .sku-more{
      display:block;width:100%;margin-top:4px;padding:3px 0;
      border:0;border-radius:5px;background:transparent;
      color:#64748b;font:600 11px/1.5 system-ui,sans-serif;cursor:pointer;
      text-align:center;transition:background .12s,color .12s;
    }
    .sku-more:hover{background:#f1f5f9;color:#334155}
    .sku-more.is-open{color:#94a3b8}

    /* 评论：纯文本，可拖选。
       可读性三件事（都不动结构）：
         ① 字体换成系统里那套「为界面小字调过」的黑体（微软雅黑 UI / 苹方），
            不用浏览器默认的宋/衬线回退；显式写字体栈，避免继承成站点的字体。
         ② 原声正文从 #475569 加深到 #1f2937 —— 原来是「灰」，小字发虚。
         ③ 总结句（无小点的那行）比原声大 1px 并加粗，一眼能分出「结论 / 证据」。 */
    .pt{margin-top:8px}
    .pt:first-of-type{margin-top:0}
    /* 标题居左、占比居右：百分比在卡片右缘成一列，横着扫一遍就能比大小。
       space-between 而不是 margin-left:auto —— 标题再长也只会自己换行，不会把占比挤走。 */
    .pt-h{
      display:flex;align-items:baseline;justify-content:space-between;gap:8px;
      font-family:"PingFang SC","Microsoft YaHei UI","Microsoft YaHei","Hiragino Sans GB","Noto Sans SC",system-ui,sans-serif;
      font-size:13px;font-weight:700;color:#0f172a;line-height:1.45;margin-bottom:3px;
    }
    /* 占比和标题同一套字体（只继承，不另写 font-family / size / weight），
       只把颜色压成灰色做层级；tabular-nums 让 1.5 / 12.5 小数点对齐。 */
    .pt-h i{
      font-style:normal;color:#94a3b8;font-variant-numeric:tabular-nums;
      flex:0 0 auto;white-space:nowrap;
    }
    /* 标题 / 占比各自是独立的复制热区（payload 在 data-copy 上，见 buildReviewGroup）。
       提示只用 background + box-shadow：box-shadow 不参与排版，文字起点一个像素都不动，
       所以「能不能点」看得出来，「占不占位」完全不受影响。 */
    .pt-h [data-copy]{cursor:pointer;border-radius:3px;transition:background .12s,box-shadow .12s}
    .pt-h [data-copy]:hover{
      background:rgba(148,163,184,.18);box-shadow:0 0 0 2px rgba(148,163,184,.18);
    }
    .pt-h [data-copy]:active{background:rgba(148,163,184,.3);box-shadow:0 0 0 2px rgba(148,163,184,.3)}
    .pt ul{
      margin:0;padding:0;list-style:none;user-select:text;
      font-family:"PingFang SC","Microsoft YaHei UI","Microsoft YaHei","Hiragino Sans GB","Noto Sans SC",system-ui,sans-serif;
    }
    .pt li{
      position:relative;padding-left:11px;font-size:12.5px;line-height:1.68;color:#1f2937;
      word-break:break-word;
    }
    /* 行首记号 —— 顺带承担「这条评论几星」。
       5 星（绝大多数）保持原来的小圆点，一点没动；1~4 星把那个点换成「数字」：
       数字本身就是答案，不需要记任何图例，也不用分辨 1px 的圆/方/大小差异。
       三个约束同时满足：
         · 不占位置：绝对定位的伪元素，不参与排版，padding-left 仍是 11px
         · 不影响复制：伪元素的内容不进选区，选中 / 复制拿到的还是纯正文
         · 不动对齐：盒子就放在原来「·」那条窄缝里，正文起点一个像素都没挪 */
    .pt li::before{content:"·";position:absolute;left:2px;color:#a7b2c1}
    .pt li[data-star]::before{
      content:attr(data-star);
      left:0;top:1px;width:9px;height:20px;    /* 20 = 首行行高 21 减 1，配合 top:1 光学居中 */
      display:flex;align-items:center;justify-content:center;
      font:700 10.5px/1 ui-monospace,Consolas,monospace;
      font-variant-numeric:tabular-nums;
    }
    /* 颜色只做辅助（数字才是主判据）：4 星几乎无感，3 星琥珀，1~2 星红 */
    .pt li[data-star="4"]::before{color:#94a3b8}
    .pt li[data-star="3"]::before{color:#b45309}
    .pt li[data-star="2"]::before{color:#c2410c}
    .pt li[data-star="1"]::before{color:#b91c1c}

    .foot{
      flex:0 0 auto;color:#b6c2cf;font-size:10.5px;line-height:1.6;
      text-align:center;padding:2px 0 6px;
    }
    .foot code{
      font-family:ui-monospace,Consolas,monospace;font-size:10px;color:#94a3b8;
      background:#eef2f7;border-radius:3px;padding:0 3px;
    }

    /* 复制反馈 */
    .toast{
      position:fixed;left:50%;bottom:20px;z-index:2;
      transform:translateX(-50%) translateY(6px);
      max-width:min(78vw,420px);padding:6px 12px;border-radius:99px;
      background:rgba(15,23,42,.92);color:#fff;font-size:11.5px;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
      opacity:0;pointer-events:none;transition:opacity .15s,transform .15s;
    }
    .toast.on{opacity:1;transform:translateX(-50%) translateY(0)}

    /* 设置视图 */
    .dbg-scroll{padding:10px 10px 14px}
    .dbg{display:flex;flex-direction:column;gap:9px;font-size:12px}
    .dbg .check{display:flex;align-items:center;gap:6px;flex-wrap:wrap;color:#475569;cursor:pointer;font-size:12px}
    .dbg .check input{accent-color:#2563eb;margin:0}
    /* 开关下方的灰色小字（现在只有网络闸用；别叫 .hint，那是提示块的类名） */
    .dbg .check .sub{
      flex:0 0 calc(100% - 20px);margin-left:20px;
      color:#a3b1c2;font-size:10.5px;font-style:normal;line-height:1.45;
      font-variant-numeric:tabular-nums;
    }
    /* 分组里的小字说明（透明度那行） */
    .dbg .grp > .sub{display:block;margin:4px 0 0;color:#a3b1c2;font-size:10.5px;font-style:normal;line-height:1.45}

    /* 分组卡：一行一个可调项，左边中文名、右边当前值，改完点「应用」 */
    .dbg .stack{display:flex;flex-direction:column;gap:9px}
    .grp{border:1px solid rgba(238,242,247,var(--kds-a,1));border-radius:8px;padding:7px 8px 8px;background:rgba(252,253,255,var(--kds-a,1))}
    .grp-h{
      display:flex;align-items:baseline;justify-content:space-between;gap:6px;
      font:600 11px/1.6 system-ui,sans-serif;color:#334155;margin-bottom:5px;
    }
    .grp-h em{font-style:normal;font:400 10px/1.6 system-ui,sans-serif;color:#a3b1c2}
    .fld{display:flex;align-items:center;gap:6px;padding:1px 0}
    .fld .k{
      flex:0 0 82px;color:#7b8aa0;font-size:11px;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .fld .v{
      flex:1 1 auto;min-width:0;height:24px;border:1px solid rgba(229,234,241,var(--kds-a,1));border-radius:5px;
      padding:0 6px;font:11px/1 ui-monospace,Consolas,monospace;color:#1e293b;
      background:rgba(255,255,255,var(--kds-a,1));outline:none;
    }
    .fld .v:focus{border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.15)}
    .fld .u{flex:0 0 auto;color:#a3b1c2;font-size:10px}
    .fld.num .v{flex:0 0 58px;text-align:right}
    /* 透明度滑块：原生的 range 就够用，只统一一下高度与配色（零 JS 绘制） */
    .fld .rng{flex:1 1 auto;min-width:0;height:16px;margin:0;accent-color:#2563eb;cursor:pointer}
    .fld .pct{flex:0 0 32px;text-align:right;color:#64748b;font-size:10.5px;font-variant-numeric:tabular-nums}

    .dbg textarea{
      width:100%;min-height:200px;resize:vertical;
      border:1px solid rgba(229,234,241,var(--kds-a,1));border-radius:7px;padding:6px 7px;
      font:11px/1.55 ui-monospace,Consolas,monospace;color:#334155;
      background:rgba(255,255,255,var(--kds-a,1));outline:none;
    }
    .dbg textarea:focus{border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.15)}
    .dbg .row{display:flex;gap:6px}
    .dbg .row button{
      flex:1 1 0;height:27px;border:1px solid rgba(219,227,236,var(--kds-a,1));border-radius:6px;
      background:rgba(255,255,255,var(--kds-a,1));
      color:#475569;font:600 11.5px/1 system-ui,sans-serif;cursor:pointer;
    }
    .dbg .row button:hover{background:#f8fafc;border-color:#cbd5e1}
    .dbg .row button.primary{background:#2563eb;border-color:#2563eb;color:#fff}
    .dbg .row button.primary:hover{background:#1d4ed8}
    .dbg details.adv{border:1px solid rgba(238,242,247,var(--kds-a,1));border-radius:8px;background:rgba(252,253,255,var(--kds-a,1));overflow:hidden}
    .dbg details.adv summary{
      cursor:pointer;padding:6px 8px;list-style:none;
      font:600 11px/1.5 system-ui,sans-serif;color:#64748b;
    }
    .dbg details.adv summary::-webkit-details-marker{display:none}
    .dbg details.adv summary::before{content:"▸ ";color:#cbd5e1}
    .dbg details.adv[open] summary::before{content:"▾ "}
    .dbg details.adv[open] summary{border-bottom:1px solid rgba(238,242,247,var(--kds-a,1))}
    .dbg details.adv textarea{min-height:180px;border:0;border-radius:0;box-shadow:none}
    .dbg .stat{color:#64748b;font-size:11px;line-height:1.6;font-variant-numeric:tabular-nums}
    .dbg .note{color:#a3b1c2;font-size:10.5px;line-height:1.6}
    .dbg .note code{
      font-family:ui-monospace,Consolas,monospace;font-size:10px;color:#94a3b8;
      background:#eef2f7;border-radius:3px;padding:0 3px;
    }
  `;

  const ICON = {
    /* 左右切换 */
    swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg>',
    /* 隐藏（侧栏收起） */
    hide: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/><path d="m10 9-3 3 3 3"/></svg>',
    /* 显示（侧栏展开） */
    show: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/><path d="m8 9 3 3-3 3"/></svg>',
    /* 设置 */
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    /* 视频与广告 */
    film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4.5" width="19" height="15" rx="2"/><path d="M7 4.5v15M17 4.5v15M2.5 12h19"/></svg>',
    /* 评价分析 */
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.6-.7L3 21l1.8-4.9A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/></svg>',
    /* 商品描述 */
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/></svg>',
    /* 刷新 */
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>'
  };

  /* ---------- §7.1 视图容器 ---------- */

  const View = {
    host: null,
    root: null,
    refs: {},
    mounted: false,
    hold: false,            // 收回后置位：看门狗 / apply 都不许把 UI 叫回来，直到 resume
    unsubscribe: null,

    mount() {
      if (this.mounted || !document.body) return;
      this.mounted = true;
      this.hold = false;

      // 外层宿主：fixed 全屏、零侵入，所有 UI 都在 shadow 内
      const host = document.createElement('div');
      host.id = CONFIG.LAYER_ID;
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = [
        'position:fixed', 'inset:0',
        `z-index:${CONFIG.Z_INDEX}`,
        'pointer-events:none',
        'display:block'
      ].join(';');

      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = [
        `<style>${VIEW_CSS}</style>`,
        '<div class="layer">',
        '  <div class="panel" data-side="left" hidden>',
        '    <div class="panel-head">',
        '      <span class="panel-title"><span class="dot"></span>预留区</span>',
        '      <span class="panel-meta">',
        '        <input class="meta-num" data-ref="hostW" type="text" inputmode="numeric"',
        '               autocomplete="off" spellcheck="false" value="-"',
        '               title="点这里直接输入宿主宽度，回车生效；Esc 取消">',
        '        <span>px 宿主 · <b data-ref="reserveW">-</b>px 预留</span>',
        '      </span>',
        '      <span class="panel-actions">',
        `        <button class="icon-btn" data-act="${ACT.REFRESH}" title="重新采集页面数据">${ICON.refresh}</button>`,
        `        <button class="icon-btn" data-act="${ACT.VIEW}" title="设置 / 调试（再点一次返回）">${ICON.gear}</button>`,
        `        <button class="icon-btn" data-act="${ACT.SIDE}" title="切换预留区到另一侧（Alt+X）">${ICON.swap}</button>`,
        `        <button class="icon-btn" data-act="${ACT.TOGGLE}" title="隐藏预留区，恢复整页宽（Alt+Z）">${ICON.hide}</button>`,
        '      </span>',
        '    </div>',
        '    <div class="panel-body">',

        /* ── 展示界面 ── */
        '      <div class="view view-show on">',
        '        <div class="navbar">',
        `          <button class="nav-btn" data-nav="${NAV.REVIEWS}" title="滚到「评价分析」并对准好评点">${ICON.chat}<span>评价分析</span></button>`,
        `          <button class="nav-btn" data-nav="${NAV.VIDEO}" title="滚到「视频与广告」并对准视频内容">${ICON.film}<span>视频与广告</span></button>`,
        `          <button class="nav-btn" data-nav="${NAV.DESC}" title="打开页面上的「商品描述」弹窗">${ICON.doc}<span>商品描述</span></button>`,
        `          <button class="nav-btn sub" data-sec="selling" title="回到本栏顶部（卖点）">回到顶部</button>`,
        `          <button class="nav-btn sub" data-sec="good" title="滚到本栏的「好评点」">好评点</button>`,
        `          <button class="nav-btn sub" data-sec="bad" title="滚到本栏的「吐槽点」">吐槽点</button>`,
        '        </div>',
        '        <div class="scroll">',
        '          <div class="cards" data-ref="cards"></div>',
        '          <div class="foot">',
        '            <code>Alt</code>+<code>Z</code> 隐藏 / 显示，<code>Alt</code>+<code>X</code> 左右切换，分隔线可调宽度',
        '          </div>',
        '        </div>',
        '      </div>',

        /* ── 设置 / debug 界面 ── */
        '      <div class="view view-debug">',
        '       <div class="scroll dbg-scroll">',
        '        <div class="dbg">',
        '          <label class="check"><input type="checkbox" data-ref="optCollapse"> 自动把「更多」点成「收起」</label>',
        '          <label class="check"><input type="checkbox" data-ref="optBlockNet"> 截断第三方广告 / 埋点<em class="sub" data-ref="netHint"></em></label>',
        '          <label class="check"><input type="checkbox" data-ref="optForceReview"> 评价未解锁也采集</label>',

        '          <div class="grp">',
        '            <div class="grp-h">跳转落点<em>正数 = 继续往下滚，负数 = 往回</em></div>',
        '            <label class="fld num"><span class="k">评价分析</span>',
        '              <input class="v" data-jump="reviews" type="text" inputmode="numeric" autocomplete="off" spellcheck="false">',
        '              <span class="u">px</span></label>',
        '            <label class="fld num"><span class="k">视频与广告</span>',
        '              <input class="v" data-jump="video" type="text" inputmode="numeric" autocomplete="off" spellcheck="false">',
        '              <span class="u">px</span></label>',
        '          </div>',

        /* 定位表：按 T / S / API / PRIORITY / NUMERIC 分组，一行一项，由 §17 动态铺 */
        '          <div class="stack" data-ref="dbgForm"></div>',

        /* 面板透明度：放在动态表单之后（即「纯数字复制」下面）——
         * 这是「偶尔才用一次」的调试项，不该占着设置页最上面的位置。
         * 静态节点，不进 dbgForm：Debug.renderForm() 只清空 stack 的子节点，碰不到它。 */
        '          <div class="grp">',
        '            <div class="grp-h"><span>面板透明度</span><em>只调底色，文字不透明</em></div>',
        '            <label class="fld"><span class="k">底色不透明度</span>',
        `              <input class="rng" data-ref="optAlpha" type="range" min="${CONFIG.UI.ALPHA_MIN}" max="${CONFIG.UI.ALPHA_MAX}" step="1" value="${CONFIG.UI.ALPHA * 100}">`,
        '              <span class="pct" data-ref="alphaVal">100%</span></label>',
        '            <em class="sub">只影响底色 / 白块 / 描边，文字颜色永远不动。背后没有东西时看不出差别（面板身后是页面空白），有元素漏过来才会透出来。</em>',
        '          </div>',

        '          <div class="stat" data-ref="dbgStat">—</div>',
        '          <div class="row">',
        '            <button data-dbg="apply" class="primary">应用</button>',
        '            <button data-dbg="reset">恢复默认</button>',
        '          </div>',
        '          <div class="row">',
        '            <button data-dbg="collect">重新采集</button>',
        '            <button data-dbg="copyCfg">复制配置</button>',
        '          </div>',
        '          <div class="row">',
        '            <button data-dbg="copyPrompt">复制提示词（给 AI 用）</button>',
        '          </div>',
        '          <details class="adv">',
        '            <summary>原始 JSON（可直接粘贴 AI 返回的配置）</summary>',
        '            <textarea data-ref="dbgJson" spellcheck="false" autocapitalize="off"></textarea>',
        '          </details>',
        '          <div class="note">',
        '            「应用」= 写进本浏览器的 localStorage，刷新、重启、重装脚本都还在。',
        '            换浏览器或换电脑：先「复制配置」，到新设备粘进「原始 JSON」再应用；',
        '            想让配置跟着脚本走，就把 JSON 粘进脚本里的 <code>LOC_EMBEDDED</code>。',
        '          </div>',
        '        </div>',
        '      </div>',
        '      </div>',

        '    </div>',
        '  </div>',
        '  <div class="divider" data-side="left" hidden>',
        '    <i class="line"></i><i class="grip"></i>',
        '  </div>',
        '  <div class="bubble"></div>',
        '  <div class="toast"></div>',
        '  <div class="mini" data-side="left" hidden>',
        `    <button data-act="${ACT.TOGGLE}" title="显示预留区（Alt+Z）">${ICON.show}</button>`,
        `    <button data-act="${ACT.SIDE}" title="切换预留区到另一侧（Alt+X）">${ICON.swap}</button>`,
        '  </div>',
        '</div>'
      ].join('');

      document.body.appendChild(host);
      this.host = host;
      this.root = root;

      const q = (selector) => root.querySelector(selector);
      this.refs = {
        panel: q('.panel'),
        divider: q('.divider'),
        bubble: q('.bubble'),
        mini: q('.mini'),
        toast: q('.toast'),
        hostW: q('[data-ref="hostW"]'),
        reserveW: q('[data-ref="reserveW"]'),
        // v0.6 功能层
        body: q('.panel-body'),
        viewShow: q('.view-show'),
        viewDebug: q('.view-debug'),
        cards: q('[data-ref="cards"]'),
        optCollapse: q('[data-ref="optCollapse"]'),
        optBlockNet: q('[data-ref="optBlockNet"]'),
        optForceReview: q('[data-ref="optForceReview"]'),
        optAlpha: q('[data-ref="optAlpha"]'),
        alphaVal: q('[data-ref="alphaVal"]'),
        netHint: q('[data-ref="netHint"]'),
        dbgForm: q('[data-ref="dbgForm"]'),
        dbgStat: q('[data-ref="dbgStat"]'),
        dbgJson: q('[data-ref="dbgJson"]')
      };

      this.bindInteractions();
      this.render(Store.state);
      Cards.render();                                   // 先铺上「读取中」的骨架
      if (Store.state.view === 'debug') Debug.prefill();
      // 先解掉上一次订阅再订阅，避免看门狗重挂时监听器越堆越多
      if (this.unsubscribe) this.unsubscribe();
      this.unsubscribe = Store.subscribe((state) => this.render(state));
    },

    /**
     * 看门狗：SPA 路由若把 <body> 整体换掉（部分站点会），我们的 fixed 层会跟着
     * 一起消失，而 mounted 仍是 true，于是面板再也回不来。这里周期性检查连接状态，
     * 掉了就重新挂一次（幂等，不会重复创建）。
     */
    ensureMounted() {
      if (this.hold) return;
      if (!this.mounted) { this.mount(); return; }
      if (this.host && !this.host.isConnected && document.body) {
        this.mounted = false;
        this.host = null;
        this.root = null;
        this.refs = {};
        this.mount();
      }
    },

    /**
     * 收回：把整层 DOM 摘掉（面板、迷你条、toast 一起走）。
     * 同时置 hold —— 否则下一次 apply() 或看门狗会立刻把它挂回来。
     * 这里不碰任何页面节点：宽度只是 html 上的一个属性，§5/§6 全是「关掉即复原」。
     */
    unmount() {
      this.hold = true;
      if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; }
      if (this.host && this.host.parentNode) this.host.parentNode.removeChild(this.host);
      this.host = null;
      this.root = null;
      this.refs = {};
      this.mounted = false;
    },

    /* ---------- §7.2 事件绑定：全部用事件委托，避免每帧重绑 ---------- */

    bindInteractions() {
      const root = this.root;

      // 面板按钮 / 迷你条按钮 —— 一个入口分发
      root.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-act]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        const action = button.getAttribute('data-act');
        if (action === ACT.SIDE) App.toggleSide();
        else if (action === ACT.TOGGLE) App.toggleEnabled();
        else if (action === ACT.VIEW) Debug.toggle();
        else if (action === ACT.REFRESH) Features.refresh(true);
      });

      /* v0.6 功能层：三条委托，全部挂在 shadow root 上，不碰页面节点 */
      root.addEventListener('click', (event) => {
        // ① 点击即复制：payload 写在 data-copy 上，DOM 里不带任何业务判断
        const copyable = event.target.closest('[data-copy]');
        if (copyable) {
          event.preventDefault();
          Clip.copy(copyable.getAttribute('data-copy'));
          return;
        }
        // ② 本栏内跳转（回到顶部 / 好评点 / 吐槽点）：只动预留区，不动页面
        const seek = event.target.closest('button[data-sec]');
        if (seek) {
          event.preventDefault();
          View.scrollToSection(seek.getAttribute('data-sec'));
          return;
        }
        // ③ 跳转条：两个是「滚动」，商品描述是「点开站点弹窗」，入口同一个
        const nav = event.target.closest('[data-nav]');
        if (nav) {
          event.preventDefault();
          const kind = nav.getAttribute('data-nav');
          if (kind === NAV.DESC) Desc.open();
          else Jump.run(kind);
          return;
        }
        // ④ 设置界面里的按钮
        const dbg = event.target.closest('[data-dbg]');
        if (dbg) {
          event.preventDefault();
          Debug.action(dbg.getAttribute('data-dbg'));
        }
      });

      if (this.refs.optCollapse) {
        this.refs.optCollapse.addEventListener('change', (event) => {
          Store.state.autoCollapse = !!event.target.checked;
          App.savePreferences();
          if (Store.state.autoCollapse) More.awaitAndClick(8000);
        });
      }

      /* 评价解锁门：关着 = 只在页面上已经能看到评论时才采集（默认） */
      if (this.refs.optForceReview) {
        this.refs.optForceReview.addEventListener('change', (event) => {
          Store.state.forceReviews = !!event.target.checked;
          App.savePreferences();
          if (Store.state.forceReviews) Features.refresh(true);     // 刚打开：立刻补采一次
          View.toast(Store.state.forceReviews ? '已开启：未解锁也照拉接口' : '已关闭：未解锁就不再采集');
        });
      }

      /* 网络闸开关：原型改写在 document-start，撤不回来，所以只能「下次加载生效」 */
      if (this.refs.optBlockNet) {
        this.refs.optBlockNet.addEventListener('change', (event) => {
          Store.state.blockNet = !!event.target.checked;
          App.savePreferences();
          Debug.netHint();
          View.toast(Store.state.blockNet ? '已开启，刷新后广告/埋点不再加载' : '已关闭，刷新后恢复正常加载');
        });
      }

      /* 透明度滑块：拖动时只改变量（一帧一次样式写入），松手才落盘 */
      if (this.refs.optAlpha) {
        this.refs.optAlpha.addEventListener('input', (event) => {
          const pct = Util.clamp(parseInt(event.target.value, 10) || 100,
            CONFIG.UI.ALPHA_MIN, CONFIG.UI.ALPHA_MAX);
          Store.state.alpha = pct / 100;
          StyleLayer.setAlpha(Store.state.alpha);
          View.setAlphaLabel(pct);
        });
        this.refs.optAlpha.addEventListener('change', () => App.savePreferences());
      }

      /* 设置界面里改值：委托到 shadow root，字段是动态铺的，不逐个绑 */
      this.refs.viewDebug.addEventListener('input', (event) => {
        const field = event.target.closest('[data-loc],[data-jump]');
        if (field) Debug.input(field);
      });
      this.refs.viewDebug.addEventListener('change', (event) => {
        const field = event.target.closest('[data-loc],[data-jump]');
        if (field) Debug.input(field);
      });
      // 原始 JSON：合法就回灌表单，中间态不合法就静静等着
      this.refs.dbgJson.addEventListener('input', () => Debug.fromJson());

      // 双击分隔线：回到默认宽度
      this.refs.divider.addEventListener('dblclick', (event) => {
        event.preventDefault();
        App.resetHostWidth();
      });

      // 顶栏宽度数字：点击即输入，回车生效、Esc 取消
      const input = this.refs.hostW;
      let cancelled = false;

      input.addEventListener('keydown', (event) => {
        event.stopPropagation();               // 别让 Alt 快捷键和站点快捷键抢键
        if (event.key === 'Enter') {
          event.preventDefault();
          input.blur();                        // 统一走 blur 提交，避免两条提交路径
        } else if (event.key === 'Escape') {
          cancelled = true;
          event.preventDefault();
          input.blur();
        }
      });

      input.addEventListener('focus', () => input.select());

      input.addEventListener('blur', () => {
        if (cancelled) {
          cancelled = false;
          input.value = String(Store.state.hostW);
          return;
        }
        const digits = String(input.value).replace(/[^\d]/g, '');
        const next = parseInt(digits, 10);
        if (!isFinite(next) || next <= 0) {
          input.value = String(Store.state.hostW);
          return;
        }
        App.setHostWidth(next);
        input.value = String(Store.state.hostW);   // 被夹取时回写真正生效的值
      });

      // 拖拽
      this.bindDrag();
    },

    bindDrag() {
      const divider = this.refs.divider;

      // 拖拽会话状态：全部基于 pointerdown 那一刻的起点做「增量」计算，
      // 而不是把鼠标的绝对 x 当成新宽度。否则在 13px 宽的分隔线上点偏 6px，
      // 宽度就会瞬间跳 6px；增量法下原地单击（位移 0）宽度完全不变。
      let pointerId = null;
      let startX = 0;
      let startHostW = 0;
      let rafId = 0;
      let pendingX = 0;

      const applyTo = (clientX) => {
        const realW = Store.state.realW;
        const side = Store.state.side;
        const delta = clientX - startX;

        // 分隔线在视口中的位置 → 宿主宽度（增量）
        const raw = side === SIDE.RIGHT ? startHostW + delta : startHostW - delta;
        // 只夹物理边界：不比视口宽，也不窄到没有。预留区不设下限。
        let next = Util.clamp(Math.round(raw), Math.min(CONFIG.HOST_FLOOR, realW), realW);

        // 1400 吸附（视口还不够宽时不做，免得把宿主顶出视口）
        const snapped = CONFIG.DEFAULT_HOST_W + CONFIG.SNAP_RADIUS < realW
          && Math.abs(next - CONFIG.DEFAULT_HOST_W) <= CONFIG.SNAP_RADIUS;
        if (snapped) next = CONFIG.DEFAULT_HOST_W;

        App.previewHostWidth(next, snapped);
      };

      /** pointermove 可能 120Hz，用 rAF 合并，一帧最多写一次 DOM / 一次样式变量 */
      const scheduleMove = (clientX) => {
        pendingX = clientX;
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          applyTo(pendingX);
        });
      };

      const flushMove = (clientX) => {
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        applyTo(clientX);
      };

      const onPointerDown = (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        pointerId = event.pointerId;
        startX = event.clientX;
        startHostW = Store.state.hostW;
        try { divider.setPointerCapture(pointerId); } catch (e) {}

        divider.classList.add('dragging');
        StyleLayer.setDragging(true);
        // 按下不动就不改宽度，只把气泡亮出来
        View.renderDrag(Store.state.hostW, Store.state.reserveW, false);
      };

      const onPointerMove = (event) => {
        if (pointerId === null || event.pointerId !== pointerId) return;
        event.preventDefault();
        scheduleMove(event.clientX);
      };

      const onPointerUp = (event) => {
        if (pointerId === null || event.pointerId !== pointerId) return;
        pointerId = null;
        try { divider.releasePointerCapture(event.pointerId); } catch (e) {}
        flushMove(event.clientX);      // 补上最后一帧，避免松手位置丢失
        divider.classList.remove('dragging');
        StyleLayer.setDragging(false);
        App.commitHostWidth();
      };

      divider.addEventListener('pointerdown', onPointerDown);
      divider.addEventListener('pointermove', onPointerMove);
      divider.addEventListener('pointerup', onPointerUp);
      divider.addEventListener('pointercancel', onPointerUp);
    },

    /* ---------- §7.3 渲染：只读状态，只写 DOM ---------- */

    render(state) {
      if (!this.mounted) return;
      const { panel, divider, mini, bubble } = this.refs;

      // 布局关掉时，整个 UI 只剩迷你条
      const showPanel = state.enabled && state.canSplit !== false;
      panel.hidden = !showPanel;
      divider.hidden = !showPanel;
      mini.hidden = state.enabled;
      if (!state.enabled) bubble.classList.remove('show');

      panel.setAttribute('data-side', state.side);
      divider.setAttribute('data-side', state.side);
      mini.setAttribute('data-side', state.side);

      this.syncHostInput(state.hostW);
      this.refs.reserveW.textContent = state.reserveW;

      // 底色透明度：只写一个 CSS 变量，文字颜色不受影响（见 §5 StyleLayer.setAlpha）
      StyleLayer.setAlpha(state.alpha);
      this.syncAlpha(state.alpha);

      // 展示界面 ⇄ 设置界面：互斥，同一时刻只显示一个
      const debug = state.view === 'debug';
      this.refs.viewShow.classList.toggle('on', !debug);
      this.refs.viewDebug.classList.toggle('on', debug);
    },

    /**
     * 预留区内部跳转：只滚自己这一栏，不碰页面。
     * sec 是写在卡片上的 data-sec：selling（卖点，也就是顶部）/ good / bad。
     * 用 rect 差值算偏移，不依赖 offsetParent —— 卡片换布局也不会算错。
     */
    scrollToSection(sec) {
      const box = this.refs.viewShow && this.refs.viewShow.querySelector('.scroll');
      const node = this.refs.cards.querySelector('[data-sec="' + sec + '"]');
      if (!box || !node) return;
      const top = node.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
      try { box.scrollTo({ top: Math.max(0, top - 2), behavior: 'smooth' }); }
      catch (e) { box.scrollTop = Math.max(0, top - 2); }
    },

    /** 复制反馈：一个小气泡，2 秒后自己消失（一次性定时器） */
    toast(text) {
      if (!this.mounted) return;
      const node = this.refs.toast;
      if (!node) return;
      node.textContent = text;
      node.classList.add('on');
      if (this._toastTimer) clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => node.classList.remove('on'), 1800);
    },

    /** 拖动过程中的高频更新：只碰必要节点 */
    renderDrag(hostW, reserveW, snapped) {
      if (!this.mounted) return;
      const dividerX = Store.state.side === SIDE.LEFT ? reserveW : hostW;

      this.refs.divider.classList.toggle('snap', !!snapped);
      this.syncHostInput(hostW);
      this.refs.reserveW.textContent = reserveW;

      const bubble = this.refs.bubble;
      bubble.style.left = dividerX + 'px';
      bubble.textContent = formatDragLabel(hostW, reserveW, snapped);
      bubble.classList.add('show');
      bubble.classList.toggle('snap', !!snapped);
    },

    hideBubble() {
      if (this.mounted) this.refs.bubble.classList.remove('show');
    },

    /** 顶栏宽度输入框回写；用户正在输入时不打断 */
    syncHostInput(hostW) {
      const input = this.refs.hostW;
      if (!input) return;
      if (this.root && this.root.activeElement === input) return;
      const next = String(hostW);
      if (input.value !== next) input.value = next;
    },

    /** 设置界面里那行百分比小字 */
    setAlphaLabel(pct) {
      const node = this.refs.alphaVal;
      if (node && node.textContent !== pct + '%') node.textContent = pct + '%';
    },

    /** 滑块回写；正在拖动时不打断 */
    syncAlpha(alpha) {
      const input = this.refs.optAlpha;
      const pct = Math.round((typeof alpha === 'number' ? alpha : 1) * 100);
      if (input && this.root && this.root.activeElement !== input) input.value = String(pct);
      this.setAlphaLabel(pct);
    }
  };

  function formatDragLabel(hostW, reserveW, snapped) {
    return `${snapped ? `已吸附 ${CONFIG.DEFAULT_HOST_W} · ` : ''}宿主 ${hostW} · 预留 ${reserveW}`;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * §8  控制器
   * ═══════════════════════════════════════════════════════════════════════ */

  const App = {
    wasEnabled: true,      // 离开详情页前的开关状态，回来时照原样恢复
    suspended: false,      // 已离开详情页（此时 enabled 恒为 false，不能被当成「用户收起」写进存档）

    /** 从 localStorage 恢复偏好（side / hostW / 各开关，含「已收起」） */
    loadPreferences() {
      const saved = Util.readJSON(CONFIG.STORAGE_KEY);
      if (!saved) return;
      if (saved.side === SIDE.LEFT || saved.side === SIDE.RIGHT) {
        Store.state.side = saved.side;
      }
      // 收起状态也跟着走：上次收起了，这次仍然收起（只影响 UI 与页面宽度，
      // 采集、跳转、复制这些功能照常跑，见 Features.start）
      if (typeof saved.enabled === 'boolean') {
        Store.state.enabled = saved.enabled;
      }
      // 1280 是旧版默认值（不是用户挑的），旧存档直接丢弃，让新默认 1400 生效
      if (typeof saved.hostW === 'number' && isFinite(saved.hostW) && saved.hostW !== 1280) {
        Store.state.userHostW = saved.hostW;
      }
      if (typeof saved.autoCollapse === 'boolean') {
        Store.state.autoCollapse = saved.autoCollapse;
      }
      if (typeof saved.blockNet === 'boolean') {
        Store.state.blockNet = saved.blockNet;
      }
      if (typeof saved.forceReviews === 'boolean') {
        Store.state.forceReviews = saved.forceReviews;
      }
      // 透明度：夹到 [下限, 1]，防止手改 localStorage 后出现 0（面板彻底看不见、找不回来）
      if (typeof saved.alpha === 'number' && isFinite(saved.alpha)) {
        Store.state.alpha = Util.clampAlpha(saved.alpha);
      }
    },

    savePreferences() {
      Util.writeJSON(CONFIG.STORAGE_KEY, {
        side: Store.state.side,
        hostW: Store.state.userHostW,
        // 收起 / 展开的记忆：离开详情页期间 enabled 被强制置 false，那不是用户的选择
        enabled: this.suspended ? this.wasEnabled : Store.state.enabled,
        autoCollapse: Store.state.autoCollapse,
        forceReviews: Store.state.forceReviews,
        blockNet: Store.state.blockNet,
        alpha: Store.state.alpha
      });
    },

    /** 重新测量真实宽度并整体应用 */
    apply() {
      const state = Store.state;
      const realW = state.realW || CONFIG.DEFAULT_HOST_W;

      // 用户操作时顺手确认 UI 还在（站点整体重绘可能把我们的层删掉）。
      // 只是一次 isConnected 判断，不监听、不轮询。
      View.ensureMounted();

      const layout = Layout.compute(realW, { userHostW: state.userHostW });

      const gapLeft = (state.enabled && state.side === SIDE.LEFT) ? layout.reserveW : 0;
      const gapRight = (state.enabled && state.side === SIDE.RIGHT) ? layout.reserveW : 0;

      StyleLayer.setEnabled(state.enabled);
      StyleLayer.setMetrics(layout.hostW, layout.reserveW, gapLeft, gapRight);

      // 唯一的落点：写回状态，订阅者（视图）自动重绘。
      // 关闭分区时宿主就是整个视口 —— 让 state 与实际布局保持一致，
      // 否则「隐藏后」state.hostW 还停在旧宿主宽度，和页面上 1913 的全宽互相矛盾。
      Store.patch({
        hostW: state.enabled ? layout.hostW : layout.realW,
        reserveW: state.enabled ? layout.reserveW : 0,
        canSplit: layout.canSplit
      });

      // 通栏 fixed 组件由 §5 的静态 CSS 规则处理，这里不需要任何扫描。

      Util.log(`宿主 ${layout.hostW}px | 预留 ${layout.reserveW}px | 真实 ${realW}px | 侧 ${state.side} | ${state.enabled ? '开' : '关'}`);
    },

    /** 拖动中的预览：改状态 + 变量，不落盘、不重算布局 */
    previewHostWidth(hostW, snapped) {
      const realW = Store.state.realW;
      const reserveW = Math.max(0, realW - hostW);
      Store.state.hostW = hostW;
      Store.state.reserveW = reserveW;
      StyleLayer.setMetrics(hostW, reserveW,
        Store.state.side === SIDE.LEFT ? reserveW : 0,
        Store.state.side === SIDE.RIGHT ? reserveW : 0);
      View.renderDrag(hostW, reserveW, snapped);
    },

    /** 松手：记住位置并通知页面重排 */
    commitHostWidth() {
      Store.state.userHostW = Store.state.hostW;
      this.savePreferences();
      View.hideBubble();
      View.refs.divider.classList.remove('snap');
      View.render(Store.state);

      // 页面自己的图表 / 表格可能只监听 window resize，
      // 我们改了布局但窗口没变，需要主动通知一次（下一帧，避免打断 pointerup）。
      setTimeout(() => {
        try { window.dispatchEvent(new Event('resize')); } catch (e) {}
      }, 0);
    },

    /** 双击复位：回到默认宽度，并清掉手动记忆 */
    resetHostWidth() {
      Store.state.userHostW = null;
      this.savePreferences();
      this.apply();
      View.hideBubble();
      View.refs.divider.classList.remove('snap');
      Util.log(`已复位到 ${CONFIG.DEFAULT_HOST_W}`);
    },

    /**
     * 直接指定宿主宽度（面板顶栏那个数字就是入口）。
     * 只夹物理边界 [HOST_FLOOR, 真实宽度]：站点被压窄后横溢是允许的。
     */
    setHostWidth(next) {
      const realW = Store.state.realW || CONFIG.DEFAULT_HOST_W;
      const wanted = Math.round(next);
      const clamped = Util.clamp(wanted, Math.min(CONFIG.HOST_FLOOR, realW), realW);

      Store.state.userHostW = clamped;
      this.savePreferences();
      this.apply();
      View.hideBubble();
      View.refs.divider.classList.remove('snap');

      if (clamped !== wanted) {
        Util.log(`输入 ${wanted} 超出范围，已改用 ${clamped}（允许 ${CONFIG.HOST_FLOOR}–${realW}）`);
      }
      // 布局改了但窗口没变，通知站点重排一次
      setTimeout(() => {
        try { window.dispatchEvent(new Event('resize')); } catch (e) {}
      }, 0);
    },

    toggleEnabled() {
      Store.patch({ enabled: !Store.state.enabled });
      this.savePreferences();          // 收起 / 展开是要记住的（下次打开还是这个样子）
      this.apply();
      // 开关切换后真实可用宽度可能变化（滚动条出现/消失），下一帧再校准一次
      setTimeout(() => this.recalibrate(), 60);
    },

    /* ---------- 区域切换：详情页 ⇄ 别的页（见 §0.7） ---------- */

    /**
     * 离开详情页 → 收回。
     * 两步：关掉分区开关（宽度、window.innerWidth 伪装同一帧全部回到真实值）→ 卸掉 UI。
     * 不刷新页面、不停脚本：NetGuard 与 getter 留着，它们本来就只影响本页的加载速度。
     */
    retract() {
      this.wasEnabled = Store.state.enabled;
      this.suspended = true;
      if (Store.state.enabled) { Store.patch({ enabled: false }); this.apply(); }
      View.unmount();
      Util.log('不在详情页了，已收回（宽度恢复，UI 摘除）');
    },

    /** 回到详情页 → 恢复收回前的状态（用户自己 Alt+Z 关掉的，不替他打开） */
    resume() {
      View.mount();
      this.suspended = false;
      if (this.wasEnabled === false) { View.render(Store.state); return; }
      if (!Store.state.enabled) { Store.patch({ enabled: true }); this.apply(); }
      Features.refresh(true);
      Util.log('回到详情页，已恢复');
    },

    toggleSide() {
      const next = Store.state.side === SIDE.LEFT ? SIDE.RIGHT : SIDE.LEFT;
      Store.patch({ side: next });
      this.savePreferences();
      this.apply();
    },

    /** 只在真实视窗变化时重算（页面自己派发的 resize 会被挡掉）；带重入保护 */
    recalibrate() {
      if (this.recalibrating) return;         // 防止 resize 回调把自己再触发一次
      this.recalibrating = true;
      try {
        const next = measureLayoutWidth();
        if (Math.abs(next - Store.state.realW) < 1) return;
        Store.state.realW = next;
        this.apply();
      } finally {
        this.recalibrating = false;
      }
    },

    bindGlobalEvents() {
      const onResize = Util.debounce(() => this.recalibrate(), 120);
      window.addEventListener('resize', onResize, { passive: true });

      // 首屏还没内容时没有纵向滚动条，测出的可用宽度会偏大，分层校准。
      // 同时兼容「脚本不是 document-start 加载」的情况：那时这些事件已经过去，
      // 直接同步校准一次，否则 realW 会一直停在 boot 时的估算值上。
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => this.recalibrate(), { once: true });
      } else {
        this.recalibrate();
      }

      if (document.readyState === 'complete') {
        setTimeout(() => this.recalibrate(), 300);
      } else {
        window.addEventListener('load', () => this.recalibrate(), { once: true });
      }

      this.scheduleCalibration();

      document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        this.recalibrate();
        View.ensureMounted();      // 面板若被站点重绘掉，切回标签页时顺手补挂
        More.click();              // 站点重绘后「更多」可能又回来了，顺手再收一次
      });

      window.addEventListener('keydown', (event) => {
        if (!event.altKey) return;
        const key = event.key.toLowerCase();
        if (key === 'z') { event.preventDefault(); this.toggleEnabled(); }
        else if (key === 'x') { event.preventDefault(); this.toggleSide(); }
      }, true);
    },

    /**
     * 有限次校准：刷新后的前 4 秒内跑固定 5 次，然后**永久停止**。
     *
     * 为什么需要它：首屏内容还没加载完时没有纵向滚动条，量到的可用宽度会偏大
     * （1924 而不是 1913），表现为预留区宽 11px、页面右边被切掉一条。
     *
     * v0.6.2 之前铺到 16 秒（200/600/1200/2400/4000/7000/11000/16000），
     * 那是为「load 要 20 秒」准备的；现在 §0.6 把广告像素截断后 load 只要 1.2~1.6 秒，
     * 布局 4 秒内必然稳定，后三次（7/11/16 秒）纯属空转，删掉。
     *
     * 为什么不用 setInterval：那会是永久轮询。这里是 5 个一次性定时器，
     * 跑完就没了；每次开销 = 插一个 1px 探针、读一个数、删掉，不触发布局重排。
     */
    scheduleCalibration() {
      const delays = [200, 600, 1200, 2400, 4000];
      delays.forEach((ms) => setTimeout(() => this.recalibrate(), ms));
    },

    init() {
      this.loadPreferences();

      // ① 最早时刻：先定一个可用的尺寸，再装伪装（window 级，不需要 DOM）
      const bootWidth = NativeProbe.innerWidth();
      Store.state.realW = bootWidth > 400 ? bootWidth : 1920;
      const bootLayout = Layout.compute(Store.state.realW, { userHostW: Store.state.userHostW });
      Store.state.hostW = bootLayout.hostW;
      Store.state.reserveW = bootLayout.reserveW;

      Spoofer.installWindow();

      // ② <html> 出现：立刻装样式（避免首屏按全宽排版再跳），补 document 级伪装
      whenDocumentElement(() => {
        StyleLayer.install();
        Spoofer.installDocument();
        Store.state.realW = measureLayoutWidth();
        this.apply();
      });

      // ③ <body> 出现：补 body 级伪装 + 挂 UI，然后启动功能层
      whenBody(() => {
        Spoofer.installBody();
        View.mount();
        Features.start();
      });

      this.bindGlobalEvents();

      // ⑤ 区域哨兵：同文档内换了 URL（前端路由不刷新文档）→ 收回 / 恢复。
      //    详情页以外的区域以后各挂一个 start()，这张表（§0.7）就是唯一入口。
      Region.watch((key) => {
        if (key === 'detail') this.resume();
        else this.retract();
      });

      // ④ 调试接口
      window.KDS_SPLIT = {
        get state() { return Object.assign({}, Store.state, { config: CONFIG }); },
        set(options) {
          const opts = options || {};
          if (opts.side === SIDE.LEFT || opts.side === SIDE.RIGHT) Store.patch({ side: opts.side });
          if (typeof opts.hostW === 'number') Store.state.userHostW = opts.hostW;
          if (typeof opts.alpha === 'number') {
            Store.state.alpha = Util.clampAlpha(opts.alpha > 1 ? opts.alpha / 100 : opts.alpha);
          }
          App.savePreferences();
          App.apply();
          if (View.mounted) View.render(Store.state);
        },
        reset() {
          Util.removeKey(CONFIG.STORAGE_KEY);
          Store.patch({ side: CONFIG.DEFAULT_SIDE, enabled: true });
          Store.state.userHostW = CONFIG.DEFAULT_HOST_W;
          App.apply();
          App.savePreferences();
        },

        // —— 功能层调试入口（只在控制台用，不影响正常流程）——
        jump(kind) { return Jump.run(kind); },
        desc() { return Desc.open(); },
        collect() { return Features.refresh(true); },
        /** 当前生效的定位表（含 JUMP 偏移），外部 AI 用 9222 读这个就够 */
        loc() { return JSON.parse(LOC.dump()); },

        /**
         * ★ 定位体检 —— 外部 AI 恢复定位的第一步就该跑这个。
         * 实现见 §16.5 Diagnostics（提示词取同一份数据，避免两套口径）。
         */
        probe() { return Diagnostics.probe(); },
        /** 网络闸现状：开关 / 本次已拦几个 / 黑名单 */
        net() {
          return {
            enabled: Store.state.blockNet !== false,
            hits: NetGuard.hits,
            block: CONFIG.NET.BLOCK.slice(),
            timing: (() => {
              const nav = performance.getEntriesByType('navigation')[0];
              return nav ? { dcl: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd) } : null;
            })()
          };
        },
        /** 与设置界面「复制提示词」同一份文本，CDP 里直接取比读剪贴板方便 */
        prompt() { return Debug.buildPrompt(); },
        /**
         * 看一眼跳转链路的现状：页签在不在、站点自己会把页面滚到哪、当前偏移多少。
         * 跳转已经不看任何文字了，所以这里只报滚动相关的数。
         */
        jumpInfo(kind) {
          const key = kind === NAV.VIDEO ? 'tabVideo' : 'tabReviews';
          const tab = Jump.tabElement(key);
          const rect = tab ? tab.getBoundingClientRect() : null;
          return {
            path: location.pathname,
            scrollY: Math.round(window.scrollY),
            stickyH: Jump.stickyHeight(),
            tab: rect ? {
              text: Util.norm(tab.textContent),
              top: Math.round(rect.top),
              docTop: Math.round(rect.top + window.scrollY)
            } : null,
            extra: Object.assign({}, LOC.JUMP),
            toast: View.refs && View.refs.toast ? View.refs.toast.textContent : ''
          };
        }
      };
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * §9  启动
   *   两个 DOM 就绪钩子放在最底层，供上层各处复用。
   * ═══════════════════════════════════════════════════════════════════════ */

  /**
   * 等 <html> 出现。
   * Tampermonkey 的 document-start 一般已经能拿到 documentElement，
   * 但 Chrome「文档创建即注入」（CDP addScriptToEvaluateOnNewDocument）时它还是 null，
   * 两种情况都要兜住，否则脚本会在最早时刻直接崩掉。
   */
  function whenDocumentElement(callback) {
    if (document.documentElement) { callback(document.documentElement); return; }

    let fired = false;
    const fire = (element) => {
      if (fired) return;
      fired = true;
      callback(element);
    };

    const observer = new MutationObserver(() => {
      if (document.documentElement) { observer.disconnect(); fire(document.documentElement); }
    });
    try { observer.observe(document, { childList: true, subtree: true }); } catch (e) {}

    let tries = 0;
    (function tick() {
      if (fired) return;
      if (document.documentElement) { try { observer.disconnect(); } catch (e) {} fire(document.documentElement); return; }
      if (++tries > 1200) return;
      requestAnimationFrame(tick);
    })();
  }

  /** 等 <body> 出现 */
  function whenBody(callback) {
    if (document.body) { callback(document.body); return; }

    let fired = false;
    const fire = (body) => {
      if (fired) return;
      fired = true;
      try { observer.disconnect(); } catch (e) {}   // 一旦就绪立刻解除观察，不留后台监听
      callback(body);
    };

    const observer = new MutationObserver(() => {
      if (document.body) { observer.disconnect(); fire(document.body); }
    });
    try { observer.observe(document.documentElement || document, { childList: true, subtree: true }); } catch (e) {}

    document.addEventListener('DOMContentLoaded', () => {
      if (document.body) fire(document.body);
    }, { once: true });
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * §10  定位表 —— 唯一允许写「怎么找到某个东西」的地方
   *
   *  这里集中五类知识：
   *    T       文本锚点（页面上那几行字）—— 命中率最高，站点改版通常不动文案
   *    S       CSS 选择器（属性行、芯片、常驻条）—— 备用，文案变了才用得上
   *    X       XPath（按层级定位）—— 前两条都失效时的最后一条路，站点改结构就会坏
   *    API     接口路径 —— 评论和 SKU 走接口，比点 DOM 快且稳
   *    JUMP    两个跳转在「站点自己落点」之上再多滚的像素（只影响滚动，不影响抓取）
   *    PRIORITY 属性置顶词
   *    NUMERIC  纯数字复制的关键词（这些属性点一下只复制数字，显示不变）
   *
   *  为什么要单独抽出来：站点一旦改版，只需要改这一张表。
   *  设置界面里既有「一行一项」的表单，也有原始 JSON；两者改的是同一份 draft，
   *  点「应用」热更新，不用改脚本、不用刷新。
   * ═══════════════════════════════════════════════════════════════════════ */

  const LOC = {
    base: {
      T: {
        more: '更多',              // 「更多」按钮文案（点了会变「收起」）
        tabVideo: '视频与广告',     // 详情页页签（点它就是跳转本身）
        tabReviews: '评价分析',
        good: '好评点',             // 评价分析里的区块标题（实际文案带 emoji 前缀）
        voice: '客户原声',           // 评价表格的列名：这一列有内容 = 该商品评价已解锁
        video: '视频内容',           // 视频表格的表头列名
        selling: '卖点',            // 卖点那一行的左侧标签
        desc: '商品描述'            // 「商品描述」入口的文案（XPath 失效才用它兜底）
      },
      S: {
        attrRow: 'div.mb-3.break-inside-avoid', // 商品属性行：一 label 一 value
        attrLabel: '.text-kds-fg-subtle',
        attrValue: '.text-kds-fg',
        chip: 'span[class*="rounded-full"][class*="inline-flex"]',
        sticky: '.detail-sticky-header, .ant-affix'   // 顶部常驻条
      },
      // 按层级定位，只用于「没有唯一文案、类名又天天变」的那个入口。
      // 绝对路径，站点一改结构就失效 —— 失效时面板会退回 T.desc 的文案查找，两个都找不到才提示。
      X: {
        descBtn: '//*[@id="root"]/div/div[2]/div[1]/div/div[3]/div[2]/div/div[1]/div/div[2]/div[2]/div[1]/div[5]/div[2]/button'
      },
      API: {
        insight: '/product/comment/insight',            // 好评点 / 吐槽点列表
        insightDetail: '/product/comment/insightDetail',// 某个观点下的评论（含中文翻译）
        skuAnalysis: '/product/detail/skuAnalysis'      // SKU 名称 / 价格 / 销量占比
      },
      // 属性里最常用的几项，展示时排到最前面（用「包含」匹配，主要成分也能命中「成分」）
      PRIORITY: ['品牌', '容量', '成分', '功效', '香味', '气味', '味道'],
      // 这些属性名（用「包含」匹配，如「净含量:」能命中「净含量」）点一下只复制**纯数字**，
      // 显示的文字仍是原文。典型：净含量 500毫升 → 复制 500；规格 50ml → 复制 50。
      // 遇到新的容量类说法（克数、片数、毫升……）在设置里加一个词就行，不用改脚本。
      NUMERIC: ['容量', '净含量', '规格']
    },

    T: {}, S: {}, X: {}, API: {}, PRIORITY: [], NUMERIC: [], JUMP: { reviews: 0, video: 0 },

    /** 从内置默认值重建（不动 localStorage）。JUMP 从 CONFIG 取，保证只有一个默认值来源 */
    reset() {
      this.T = Object.assign({}, this.base.T);
      this.S = Object.assign({}, this.base.S);
      this.X = Object.assign({}, this.base.X);
      this.API = Object.assign({}, this.base.API);
      this.PRIORITY = this.base.PRIORITY.slice();
      this.NUMERIC = this.base.NUMERIC.slice();
      this.JUMP = Object.assign({}, CONFIG.FEATURE.JUMP_EXTRA);
    },

    /**
     * 默认值 → 脚本内嵌 → localStorage，后者覆盖前者。
     * 三层是为了回答「换台电脑还得再调一遍吗」：把 JSON 粘进 LOC_EMBEDDED 就跟着脚本走了。
     */
    load() {
      this.reset();
      [LOC_EMBEDDED, Util.readJSON(CONFIG.LOC_KEY)].forEach((layer) => this.merge(layer));
      this.migrateJump();
    },

    /**
     * v0.6.4 起 JUMP 的含义变了：
     *   旧 = 「锚点文档坐标 − 常驻条高度 + extra」（负数 = 往下滚）
     *   新 = 「站点自己落点 + extra」        （正数 = 往下滚）
     * 老存档里的 -44 在新算法下会朝反方向偏 44px。所以升级后第一次运行清一次旧值，
     * 之后写个标记位，用户自己改过的偏移就不再被动过。
     */
    migrateJump() {
      const seen = Util.readJSON(CONFIG.JUMP_VER_KEY);
      if (seen && Number(seen.v) >= 2) return;
      this.JUMP = Object.assign({}, CONFIG.FEATURE.JUMP_EXTRA);
      Util.writeJSON(CONFIG.JUMP_VER_KEY, { v: 2 });
    },

    /**
     * 合并一层覆盖（LOC_EMBEDDED 或 localStorage）。
     * 只认 base 里存在的 key —— 老版本存下来的 good / bad / video 这类已废弃锚点
     * 会被自动丢掉，不会因为 localStorage 里还有就复活、也不会出现在体检报告里。
     */
    merge(saved) {
      if (!saved || typeof saved !== 'object') return;

      ['T', 'S', 'X', 'API'].forEach((group) => {
        const incoming = saved[group];
        if (!incoming || typeof incoming !== 'object') return;
        Object.keys(this.base[group]).forEach((key) => {
          const value = incoming[key];
          if (value == null) return;
          const text = String(value).trim();
          if (text) this[group][key] = text;
        });
      });
      if (Array.isArray(saved.PRIORITY) && saved.PRIORITY.length) {
        this.PRIORITY = saved.PRIORITY.slice();
      }
      // NUMERIC 允许存成空数组 —— 那代表「我就是要全部按原文复制」，不能当成没存过
      if (Array.isArray(saved.NUMERIC)) {
        this.NUMERIC = saved.NUMERIC.map((part) => String(part).trim()).filter(Boolean);
      }
      if (saved.JUMP && typeof saved.JUMP === 'object') {
        ['reviews', 'video'].forEach((key) => {
          const value = Number(saved.JUMP[key]);
          if (isFinite(value)) this.JUMP[key] = Math.round(value);
        });
      }
    },

    /** 导出成 JSON 字符串，供设置界面编辑 / 复制 */
    dump() {
      return JSON.stringify({
        T: this.T, S: this.S, X: this.X, API: this.API,
        PRIORITY: this.PRIORITY, NUMERIC: this.NUMERIC, JUMP: this.JUMP
      }, null, 1);
    },

    productId() {
      return Gate.productId();
    },

    /**
     * 请求头里的这三个是硬要求：缺任何一个，接口会返回
     * {"success":false,"message":"file not found"}（实测踩过）。
     * 值取自当前地址栏，与页面自己在用的筛选条件保持一致。
     */
    headers() {
      const read = (key, fallback) => {
        try { return new URL(location.href).searchParams.get(key) || fallback; }
        catch (e) { return fallback; }
      };
      return {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'country': read('region', 'VN'),
        'currency': read('currency', 'CNY'),
        'language': read('language', 'zh-CN')
      };
    },

    /**
     * 评论数据是按日期分区查的。优先用地址栏里的 dateRange —— 那正是页面上
     * 「过去30天(10/09~11/07)」在用的区间，跟着页面走就不会和展示内容打架。
     */
    dateRange() {
      try {
        const raw = new URL(location.href).searchParams.get('dateRange');
        if (raw) {
          const pair = JSON.parse(raw);
          if (Array.isArray(pair) && pair[0] && pair[1]) return { start: pair[0], end: pair[1] };
        }
      } catch (e) { /* 解析不了就走兜底 */ }
      const fmt = (date) => date.getFullYear() + '-' +
        String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
      return { start: fmt(new Date(Date.now() - 29 * 864e5)), end: fmt(new Date()) };
    },

    /**
     * 唯一的接口出口。带超时兜底 —— 这是刷新链路的「保险丝」：
     * 任何一个请求挂住（网络断开、站点接口抽风、服务端不返回），
     * 都能让 Features.refresh 的 running 永远为真，此后刷新按钮 / 设置页应用 /
     * Alt+Z 恢复全部静默失效，只能刷页面。5 秒足够：实测整条评论流水 5.8 秒里
     * 大头是「等页面渲染」，单个接口一般几百毫秒。
     */
    async post(path, body) {
      const limit = CONFIG.FEATURE.API_TIMEOUT;
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => { try { controller.abort(); } catch (e) {} }, limit) : null;

      try {
        const response = await fetch(path, {
          method: 'POST',
          headers: this.headers(),
          credentials: 'include',
          body: JSON.stringify(body),
          signal: controller ? controller.signal : undefined
        });
        let json = null;
        try { json = await response.json(); }
        catch (e) { throw new Error('返回不是 JSON（HTTP ' + response.status + '）'); }
        if (!json || json.success === false) {
          throw new Error((json && json.message) || ('接口失败 HTTP ' + response.status));
        }
        return json;
      } catch (error) {
        // 超时被 abort 时 fetch 抛的是 AbortError，翻译成人话再往上抛
        if (error && (error.name === 'AbortError' || error.code === 20)) {
          throw new Error('接口超时（超过 ' + (limit / 1000) + ' 秒未返回）');
        }
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * §11  采集层 —— 只读页面 / 只发请求，产出标准结构，绝不碰样式
   *
   *  三个产物：
   *    attrs    [{label, value, priority}]      商品属性，常用的排前面
   *    selling  ['减少掉发', …]                  卖点芯片原文
   *    skus     [{name, price, img, sales}]      SKU（多个时只留卖得最好的两个）
   *    reviews  [{key, title, points:[{point, rate, lines:[{text, star}]}]}]
   *             key = positivePoints / painPoints；star 是 1~5 的整数，只用于画行首那个记号
   * ═══════════════════════════════════════════════════════════════════════ */

  /** 文本查找：先用 textContent 粗筛（不触发排版），只对命中的元素读几何信息 */
  const Scan = {
    byText(text, options) {
      const opts = Object.assign({ maxLen: 24 }, options || {});
      // 注意：contains 必须优先于 exact —— 页面上「好评点」的真实文案是「😄好评点」，
      // 只传 contains 却按精确匹配去找，一辈子也找不到（这个坑踩过一次）。
      const fuzzy = opts.contains === true;
      const target = Util.norm(text);
      if (!target || !document.body) return [];

      const nodes = document.body.querySelectorAll('div,span,button,a,li,td,th,p,label,h1,h2,h3,h4');
      const hits = [];
      let scanned = 0;

      for (const element of nodes) {
        if (++scanned > 20000) break;                 // 页面很大时给个上限，别死磕
        const raw = element.textContent || '';
        if (raw.length > 200) continue;               // 长文本容器不可能是「一个词」
        const flat = Util.norm(raw);
        if (!flat) continue;

        const matched = fuzzy
          ? (flat.indexOf(target) >= 0 && flat.length <= opts.maxLen)
          : flat === target;
        if (!matched) continue;

        // 只保留最内层：子元素也命中，说明本元素只是外壳
        let hasInner = false;
        for (const child of element.children) {
          const childText = Util.norm(child.textContent);
          if (!childText) continue;
          if (fuzzy ? childText.indexOf(target) >= 0 : childText === target) {
            hasInner = true;
            break;
          }
        }
        if (hasInner) continue;

        hits.push(element);
      }

      return hits.filter((element) => element.getClientRects().length > 0);
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * §11.0 评价解锁门 —— 只读页面，判断「这个商品的评论是不是已经解锁了」
   *
   *  评价明细（客户原声 / 翻译）在站点上是要花积分解锁的，而我们走接口能直接拿到。
   *  所以规矩是：**页面上已经能看到评论，才去采**。
   *
   *  v0.9.2 修正：只认「已经解锁」这一种正面证据，并且给它一段时间。
   *  ————————————————————————————————————————————————————————————————
   *  以前的写法是「一次判断，判不出来就算没解锁」，于是在**早就解锁过**的商品页上
   *  永远显示「还没解锁」。原因是时序，不是判据：
   *    刷新页面后 0~1.5s   评价区还没画出来        （什么都没有）
   *    2s 左右            评价区的占位/骨架屏      （「查看样例」「点击查看」，**解锁页也会出现**）
   *    3s 左右            骨架屏消失              （依旧没有正文）
   *    4.5s 左右          真评论渲染出来          （客户原声表格里有正文）
   *  采集在 2s 左右就跑了，正好撞在骨架屏上 —— 判据当时是对的，结论却是错的。
   *
   *  所以现在只做一件事：**等正面证据**。
   *    ① 表头里有「客户原声」这一列，且表体里有 ≥8 字的真实文字 → 已解锁，放行
   *    ② 等不到（硬上限 REVIEW_GATE_WAIT，DOM 变动驱动 + 慢速兜底，跑完即撤）→ 当作未解锁
   *  不再拿「查看样例 / 点击查看」当反证 —— 它们在解锁页加载期间同样会出现，
   *  拿它做「立刻判负」会把正常商品误判成没解锁（实测 2.1s 时两者都在）。
   *
   *  上限只给 3 秒（v0.9.3 从 7 秒收紧）：采集本身要等属性行渲染完才开始，
   *  实测那个点已经在 5.8s 左右，评论 4.5s 就画好了 —— 解锁页走进来时 `real()` 当场为真，
   *  一秒都不等；这 3 秒只是给「属性先到、评论后到」的慢网络留余量。
   *  真等不到（未解锁）也不会白等太久，点「评价分析」页签或点刷新还能补判一次。
   *
   *  整个过程只读 DOM：不点按钮、不发请求，绝不会碰到站点的「解锁/消耗积分」流程。
   *  设置里的「评价未解锁也采集」（默认关）会把这道门整个跳过。
   * ═══════════════════════════════════════════════════════════════════════ */

  const ReviewGate = {
    /** 页面上已经有真评论了？—— 唯一可靠的「已解锁」证据 */
    real() {
      const want = Util.norm(LOC.T.voice);
      const heads = document.querySelectorAll('th');
      for (let i = 0; i < heads.length; i++) {
        if (Util.norm(heads[i].textContent) !== want) continue;
        const table = heads[i].closest('table');
        if (!table) continue;
        const cells = table.querySelectorAll('tbody td');
        for (let j = 0; j < cells.length; j++) {
          if (Util.norm(cells[j].textContent).length >= 8) return true;   // 有正文 = 真解锁了
        }
      }
      return false;
    },

    /** 异步：页面上能读到评论 → true；等到上限还没有 → false（宁可少采，也不替用户花钱） */
    async unlocked() {
      if (Store.state.forceReviews) return true;          // 用户明确要求强采
      if (!Util.norm(LOC.T.voice)) return true;           // 文案被清空 → 不拿它当门槛
      if (this.real()) return true;                       // 已经在位：零等待

      // 还没渲染出来：有界地等一次。Wait 是事件驱动（DOM 一变就查）+ 慢速兜底，
      // 拿到即撤，超时即撤，不留观察者、不留定时器。
      const hit = await Wait.until(
        () => this.real(),
        CONFIG.FEATURE.REVIEW_GATE_WAIT,
        500
      );
      return !!hit;
    }
  };

  const Collect = {
    /* ---------- 商品属性 ---------- */

    attrs() {
      const out = [];
      const rows = document.querySelectorAll(LOC.S.attrRow);

      rows.forEach((row) => {
        const labelEl = row.querySelector(LOC.S.attrLabel) || row.firstElementChild;
        if (!labelEl) return;

        const label = (labelEl.textContent || '').replace(/[:：]\s*$/, '').trim();
        if (!label) return;

        const valueEl = row.querySelector(LOC.S.attrValue);
        let value = (valueEl && valueEl !== labelEl) ? (valueEl.textContent || '').trim() : '';

        if (!value) {
          value = [...row.children]
            .filter((child) => child !== labelEl)
            .map((child) => (child.textContent || '').trim())
            .filter(Boolean)
            .join(' ');
        }
        if (value) out.push({ label, value, copy: this.copyOf(label, value) });
      });

      return this.rankAttrs(out);
    },

    /**
     * 点击时复制什么。
     *
     * 默认就是原文（「深层清洁」还是「深层清洁」）。
     * 只有属性名命中 NUMERIC 里的关键词（容量 / 净含量 / 规格 …）才只留数字：
     *   「500毫升」→「500」  「50 ml」→「50」  「1.5L×2」→「1.5」
     * 展示始终用原文，只有**落进剪贴板的那一份**被剥过 —— 所以页面上看到什么不受影响。
     * 剥不出数字（比如「标准装」）就退回原文，不会把内容变成空。
     */
    copyOf(label, value) {
      const keywords = LOC.NUMERIC || [];
      if (!keywords.length) return value;
      if (!keywords.some((keyword) => label.indexOf(keyword) >= 0)) return value;

      const matched = String(value).replace(/,/g, '').match(/\d+(?:\.\d+)?/);
      return matched ? matched[0] : value;
    },

    /** 常用字段提到前面，其余保持原文顺序 */
    rankAttrs(list) {
      const rankOf = (label) => {
        const index = LOC.PRIORITY.findIndex((keyword) => label.indexOf(keyword) >= 0);
        return index < 0 ? 99 : index;
      };
      return list
        .map((item, index) => ({ item, index, rank: rankOf(item.label) }))
        .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
        .map((entry) => Object.assign({}, entry.item, { priority: entry.rank < 99 }));
    },

    /* ---------- 卖点芯片 ---------- */

    selling() {
      let scope = null;
      const label = Scan.byText(LOC.T.selling, { exact: true })[0];
      if (label && label.parentElement) scope = label.parentElement.children[1] || null;

      let chips = scope ? [...scope.querySelectorAll('span')].filter((el) => this.isChip(el)) : [];

      // 兜底：标签没找到（改版）就按芯片的样式签名找
      if (!chips.length) {
        chips = [...document.querySelectorAll(LOC.S.chip)].filter((el) => this.isChip(el));
      }
      return chips.map((el) => (el.textContent || '').trim()).filter(Boolean);
    },

    isChip(el) {
      const text = (el.textContent || '').trim();
      if (!text || text.length > 24) return false;
      if (el.children.length > 1) return false;
      const rect = el.getBoundingClientRect();
      return rect.width >= 10 && rect.height >= 12 && rect.height <= 40;
    },

    /* ---------- SKU（接口） ---------- */

    async skus() {
      const response = await LOC.post(LOC.API.skuAnalysis, { id: LOC.productId(), authority: true });
      const data = (response && response.data) || {};
      const list = Array.isArray(data.skus) ? data.skus : (Array.isArray(data) ? data : []);

      const mapped = list.map((sku) => ({
        name: String(sku.sku_name || '').trim() || '(未命名)',
        price: String(sku.price_val || '').trim(),
        img: this.firstImage(sku.images),
        sales: typeof sku.sales_proportion === 'number' ? sku.sales_proportion : null
      })).filter((sku) => sku.name || sku.price);

      // 顺序保持接口原样 —— 接口返回的就是网页上从上到下显示的顺序。
      // 不再按销量占比重排（那样会和用户在网页上看到的对不上号）；
      // 条数裁剪放到渲染层（buildSkus 只露前 SKU_VISIBLE 条，其余收纳）。
      return mapped;
    },

    firstImage(raw) {
      if (!raw) return '';
      if (Array.isArray(raw)) return raw[0] || '';
      const matched = String(raw).match(/https?:\/\/[^\s,"']+/);
      return matched ? matched[0] : '';
    },

    /* ---------- 评论（接口，自带中文） ---------- */

    async reviews() {
      // 先看页面：没解锁就一个接口都不打（见 §11.0）
      if (!(await ReviewGate.unlocked())) {
        const error = new Error('评价分析未解锁，已跳过采集');
        error.kdsLocked = true;
        throw error;
      }

      const id = LOC.productId();
      const range = LOC.dateRange();
      const insight = await LOC.post(LOC.API.insight, {
        id,
        partitionDayStart: range.start,
        partitionDayEnd: range.end,
        type: 'insight'
      });

      const data = (insight && insight.data) || {};
      const groups = [
        { key: 'positivePoints', title: '好评点', points: data.positivePoints || [] },
        { key: 'painPoints', title: '吐槽点', points: data.painPoints || [] }
      ];

      const out = [];
      for (const group of groups) {
        const tasks = group.points.map((point) => async () => {
          const detail = await LOC.post(LOC.API.insightDetail, {
            id,
            pointId: point.id,
            pointKey: group.key,
            pageNo: 1,
            pageSize: CONFIG.FEATURE.REVIEW_PAGE_SIZE,
            translate: true,        // ← 关键：翻译不用点按钮，参数直接要中文
            skuName: ''
          });

          const rows = (detail && detail.data && detail.data.reviewList) || [];
          const seen = new Set();
          const lines = [];
          rows.forEach((row) => {
            const zh = String(row.translateDisplayText || '').trim();
            if (!zh || seen.has(zh)) return;
            seen.add(zh);
            // 星级跟着原文一起存（rating 是字符串，见 Util.star）。纯展示用，不参与复制。
            lines.push({ text: zh, star: Util.star(row.rating) });
          });
          // rate 归一化放在采集层做一次，视图层只负责画（见 Util.rateText）
          return { point: String(point.point || '').trim(), rate: Util.rateText(point.rate), lines };
        });

        const points = (await Util.poolMap(tasks, CONFIG.FEATURE.CONCURRENCY))
          .filter((point) => point && point.lines.length);
        out.push({ key: group.key, title: group.title, points });
      }
      return out;
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * §12  等待器 —— 内容到位就走，不到点就走
   *
   *  v0.6.2 起不再「每 N 毫秒问一次」，改成三条腿：
   *    ① 立刻查一次           —— 内容已经在了就直接返回，零等待
   *    ② MutationObserver     —— DOM 一变就在 120ms 内查一次（节流合并多次变动）
   *    ③ 800ms 慢速兜底       —— 覆盖「DOM 没变但布局变了」（字体/图片撑开、CSS 生效）
   *    ④ timeout 硬上限       —— 到点必停
   *  收手时 observer、兜底定时器、超时定时器全部回收，不留任何尾巴。
   *
   *  为什么必须留兜底 ③：跳转等的是「好评点」这种新插入的节点，observer 够用；
   *  但采集等的是「属性行已经有内容」，有时节点早就存在、只是文字后填进去的，
   *  光靠 childList 有可能漏掉（characterData 已打开，但仍留一条保险）。
   * ═══════════════════════════════════════════════════════════════════════ */

  const Wait = {
    /** 等 check() 返回真值；超时返回 null。interval 现在是最慢兜底间隔，不是轮询步长。 */
    until(check, timeout, interval) {
      const limit = typeof timeout === 'number' ? timeout : 8000;
      const fallback = Math.max(600, typeof interval === 'number' ? interval : 800);

      return new Promise((resolve) => {
        let settled = false;
        let observer = null;
        let poll = null;
        let deadline = null;
        let throttle = null;

        const done = (value) => {
          if (settled) return;
          settled = true;
          if (observer) { try { observer.disconnect(); } catch (e) { /* 已断开 */ } }
          if (poll) clearInterval(poll);
          if (deadline) clearTimeout(deadline);
          if (throttle) clearTimeout(throttle);
          resolve(value);
        };

        const probe = () => {
          if (settled) return;
          let value = null;
          try { value = check(); } catch (e) { value = null; }
          if (value) done(value);
        };

        probe();                       // ① 已经在位就别等
        if (settled) return;

        // ② DOM 变动驱动（节流 120ms：React 连刷十几次也只查一次）
        const schedule = () => {
          if (settled || throttle) return;
          throttle = setTimeout(() => { throttle = null; probe(); }, 120);
        };
        try {
          observer = new MutationObserver(schedule);
          observer.observe(document.documentElement, {
            childList: true, subtree: true, characterData: true
          });
        } catch (e) { observer = null; }

        // ③ 慢速兜底 + ④ 硬上限
        poll = setInterval(probe, fallback);
        deadline = setTimeout(() => done(null), limit);
      });
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * §13  复制层 —— 唯一的剪贴板入口
   *  优先异步剪贴板 API；它不可用（非 https / 无手势 / 权限被拒）时退回
   *  textarea + execCommand 这套老办法。
   * ═══════════════════════════════════════════════════════════════════════ */

  const Clip = {
    /** label 可省略：多行默认显示「N 条」，单行显示截断后的内容 */
    copy(text, label) {
      const value = String(text == null ? '' : text);
      if (!value.trim()) { View.toast('没有可复制的内容'); return; }

      const lines = value.split('\n').filter((line) => line.trim());
      const name = label || (lines.length > 1
        ? lines.length + ' 条'
        : (value.length > 26 ? value.slice(0, 26) + '…' : value));
      const done = () => View.toast('已复制：' + name);
      const fail = () => View.toast('复制失败，请手动选中复制');

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(done, () => {
          if (this.legacy(value)) done(); else fail();
        });
        return;
      }
      if (this.legacy(value)) done(); else fail();
    },

    legacy(value) {
      try {
        const area = document.createElement('textarea');
        area.value = value;
        area.setAttribute('readonly', '');
        area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
      } catch (e) {
        return false;
      }
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * §14  功能·收起 —— 把「更多」点成「收起」
   *
   *  两个条件同时成立才点，缺一不可：
   *    ① textContent 完全等于「更多」（不是「更多页」，不是「查看更多」）
   *    ② 它真的躺在 <button> 里（或 role=button）
   *  只按样式类名筛会误伤一大片同款次级按钮；只按文案筛会碰上分页的「更多页」。
   *
   *  点完**不做结果校验、也不打标记**（见 click 的注释）：
   *  成功展开的按钮文案会变成「收起」，自然掉出候选；点空了的下轮再点一次就好。
   *  只留一个「同一元素最多 3 次」的预算，纯防刷屏。
   * ═══════════════════════════════════════════════════════════════════════ */

  const More = {
    /**
     * 找出「文案恰好是 更多」且真的躺在按钮里的元素。
     *
     * 为什么不用样式类名：实测这三个按钮的 class 和页面上其它 38 个次级按钮
     * （API / 收费套餐 / 关注 / 过去30天 …）并不共享同一个变体，
     * 按类名筛会大面积误伤。反过来，按文案筛又必须防住分页组件里的
     * 「更多页」（那是 span，且不是按钮，文案也不完全相等）。
     * 两个条件叠起来才精确：textContent 完全等于「更多」+ 祖先里有 button。
     */
    candidates() {
      const want = Util.norm(LOC.T.more);
      const found = [];
      // 只查按钮：页面上 button / [role=button] 一共百来个，比遍历全部 div 便宜一个数量级
      document.querySelectorAll('button,[role="button"]').forEach((element) => {
        if (Util.norm(element.textContent) !== want) return;
        if (!element.getClientRects().length) return;
        if (found.indexOf(element) < 0) found.push(element);
      });
      return found;
    },

    /** element -> {n: 点过几次, t: 上次点击时间}：只用来防刷屏，不判断成败 */
    hits: new WeakMap(),

    /**
     * 点一批「文案还是更多」的按钮，返回本次点了几个。
     *
     * 这里是纯被动触发，**不校验点击结果**：点完变没变成「收起」不看、也不打标记。
     *
     * 为什么去掉「点一次就标记」：评论表格是异步渲染的，按钮先到、数据后到，
     * 那一下 click 会被组件忽略（实测：点完文案仍然是「更多」）。旧代码点完就标记，
     * 于是好评点那个按钮再没被点第二次 —— 这就是「漏展开」的原因。
     * 现在不加标记，下一轮扫描自然会再点一次，数据填好后就成了；
     * 真正展开的按钮文案会变成「收起」，自动掉出 candidates()，不会重复点。
     *
     * 唯一保留的状态是一个「点击预算」（同一元素最多 3 次）+ 400ms 间隔，
     * 防止某个点不动的按钮被反复点、也防止连点两下又收回去。
     */
    click() {
      if (!Store.state.autoCollapse) return 0;
      const now = Date.now();
      const targets = this.candidates().filter((button) => {
        const hit = this.hits.get(button) || { n: 0, t: 0 };
        if (hit.n >= 3) return false;                            // 点不动就算了，别一直点
        if (now - hit.t < 400) return false;                     // 400ms 内不重复点同一个
        const rect = button.getBoundingClientRect();
        return rect.width > 20 && rect.height > 12;
      });

      targets.forEach((button) => {
        const hit = this.hits.get(button) || { n: 0, t: 0 };
        this.hits.set(button, { n: hit.n + 1, t: now });
        try { button.click(); } catch (e) { /* 单点失败不影响其余 */ }
      });
      return targets.length;
    },

    /**
     * 盯着页面点「更多」，直到没有新的为止。
     *
     * 轮次由两种事件驱动，都不是定时轮询：
     *   · DOM 变动（MutationObserver，节流 300ms）——「更多」是分批挂上来的
     *   · 点完之后的一次性复查定时器（QUIET）
     * 收手条件：这一轮既没点到新目标，也没发生别的。任意路径收手都会 disconnect
     * 并清掉所有定时器，全局还有 timeout 硬上限兜底。
     */
    awaitAndClick(timeout) {
      if (!Store.state.autoCollapse) return Promise.resolve(0);

      const limit = typeof timeout === 'number' ? timeout : 10000;
      const QUIET = 2500;                         // 点完之后多久没有新目标算点完
      const IDLE_LIMIT = Math.min(limit, 10000);  // 一个都没出现时的等待上限（DOM 不变就不扫）

      return new Promise((resolve) => {
        let clicked = 0;
        let settled = false;
        let observer = null;
        let throttle = null;
        let quietTimer = null;
        let idleTimer = null;
        let deadline = null;

        const finish = (reason) => {
          if (settled) return;
          settled = true;
          if (observer) { try { observer.disconnect(); } catch (e) { /* 已断开 */ } }
          if (throttle) clearTimeout(throttle);
          if (quietTimer) clearTimeout(quietTimer);
          if (idleTimer) clearTimeout(idleTimer);
          clearTimeout(deadline);
          if (clicked) Util.log('「更多」已点：' + clicked + ' 次（' + reason + '）');
          resolve(clicked);
        };

        /** 点完一个之后，等 QUIET 再扫一次；还有就继续，没有就收手 */
        const armQuiet = () => {
          if (settled) return;
          if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
          if (quietTimer) clearTimeout(quietTimer);
          quietTimer = setTimeout(step, QUIET);
        };

        const step = () => {
          if (settled) return;
          const hit = this.click();
          if (hit) { clicked += hit; armQuiet(); return; }
          if (clicked) { finish('安静收手'); return; }
          // 一个都还没出现：等 DOM 变动，IDLE_LIMIT 后收手
          if (!idleTimer) idleTimer = setTimeout(() => finish('始终没出现'), IDLE_LIMIT);
        };

        step();                                    // 进来先扫一次，别等第一次 DOM 变动

        // DOM 变动驱动（节流 300ms）
        const schedule = () => {
          if (settled || throttle) return;
          throttle = setTimeout(() => { throttle = null; step(); }, 300);
        };
        try {
          observer = new MutationObserver(schedule);
          observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
        } catch (e) { observer = null; }

        deadline = setTimeout(() => finish('到上限'), limit);
      });
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * §15  功能·跳转 —— 借站点自己的滚动，只在末尾补一个固定像素
   *
   *  v0.6.4 的流程，一句话：**点页签 → 等它自己滚完 → 落到「标题贴条」的位置 + 固定像素**。
   *
   *  为什么不自己从头算目标：站点点页签时本来就会把该区块滚进视野，
   *  那条平滑滚动动画是站点自己的（实测 ~510ms、从 0 动画到 1989），我们不该重写它。
   *
   *  老版（≤ v0.6.3）的三处硬伤，这一版全部删掉：
   *    ① `Wait.until(...)` 每 120ms 轮询「好评点」是否出现 —— 最多等 9 秒，这 9 秒里
   *       界面毫无反应，就是那个「点了没动静」的卡顿；
   *    ② 等不到就弹「没找到好评点」—— 内容还没渲染完就开找，必然偶发失败；
   *    ③ 按检查点逐次校正锚点位置 —— 内容还在长高，越校越飘。
   *
   *  现在只剩「滚完之后查一次标题」：一次 querySelectorAll，实测 1910 个节点、2~3ms，
   *  查不到就返回 null，静默退回「站点落点 + 固定像素」。**不等、不重试、不弹窗。**
   *
   *  为什么还留这一次查询：站点的落点会随「AI 总结」这类块的高度漂移（同一商品 253px，
   *  别的商品可能没有这块），纯固定偏移在换商品时会差几百像素。查一次就能把
   *  「好评点贴条」这个基准找回来，代价是 3ms。
   *
   *  时序（每步都有上限，跑完即止，不留任何监听）：
   *    点页签 → 至少等 JUMP_SETTLE_MIN → 连续 JUMP_SETTLE_QUIET 没动 = 滚完
   *           → 查一次标题 → 落到「标题 + 偏移」→ 再观察 JUMP_GUARD 毫秒，被覆盖就补一次
   * ═══════════════════════════════════════════════════════════════════════ */

  const Jump = {
    running: false,
    kind: '',                                     // 正在跑的是哪一个（防连击要按「同一个按钮」判断）
    seq: 0,                                       // 序号：每次点击 +1，旧的异步步骤一比对就知道自己作废了
    until: 0,                                     // 本次收手后还要沉默到什么时候（连击的第二下落在收手之后）
    lastSticky: 0,
    tabCache: {},                                 // 找到过的页签元素，下次直接复用（失效自动重找）
    scopeCache: null,                             // 页签栏容器，同上

    /** 每个跳转只是「点哪个页签 + 对准哪个标题 + 用哪个偏移」的差别 */
    SPEC: {
      [NAV.REVIEWS]: { tab: 'tabReviews', title: 'good', maxLen: 10, half: false, extra: 'reviews' },
      [NAV.VIDEO]: { tab: 'tabVideo', title: 'video', maxLen: 8, half: true, extra: 'video' }
    },

    /**
     * 两个保护，一共 6 行，都不留监听、不留后台状态：
     *   ① 防连击：**同一个**按钮「还在跑」或「刚收手 JUMP_GUARD 毫秒内」的第二次点击直接丢弃
     *      —— 否则连点两下会跑两遍 settle（约多等 1 秒），期间毫无视觉反馈。
     *   ② 可抢占：点了另一个按钮 = 上一把点错了，旧的那次在下一个检查点自己作废，
     *      新的立刻开始 —— 从点击到画面动还是 20~30ms，不用等旧的那次跑完。
     *   两个按钮的语义天然冲突（防连击要求「别理我」，抢占要求「立刻理我」），
     *   所以判据按「同一个按钮」区分：同键 = 连击（丢），换键 = 后悔了（抢占）。
     */
    async run(kind) {
      const spec = this.SPEC[kind];
      if (!spec) return;
      if (this.kind === kind && (this.running || Date.now() < this.until)) return;
      const token = ++this.seq;
      this.kind = kind;
      this.running = true;
      const alive = () => token === this.seq;

      try {
        const before = Math.round(window.scrollY);

        // ① 点站点自己的页签 —— 它的 onclick 会自己做滚动，点完立刻有反应
        if (!this.clickTab(spec.tab)) {
          View.toast('没找到「' + LOC.T[spec.tab] + '」页签');
          return;
        }
        this.recheckReviews(kind);

        // ② 等它滚完（第一次没动就再给一次机会，防它比我们慢半拍启动）
        let landed = await this.settle();
        if (!alive()) return;                       // 被抢占：不落点、不补偏移，交给新的那次
        if (landed === before) landed = await this.settle();
        if (!alive()) return;

        // ③ 站点压根没动（早就在这个页签、这个位置）→ 不要再平移，否则每点一次往下漂一点
        if (landed === before) return;

        const extra = Number(LOC.JUMP[spec.extra]) || 0;
        const title = this.snapTitle(spec);

        // ④ 落点
        //    查到标题 → 以标题为准（标点在上面那个 AI 总结块，高度每个商品都不一样，
        //    纯固定偏移会差出几百像素）；查不到 → 就在站点落点上加固定像素。
        //    两种都只发生一次，不等、不重试、不弹窗。
        let target = landed + extra;
        if (title) {
          const rect = title.getBoundingClientRect();
          const half = spec.half ? Math.round(rect.height / 2) : 0;
          target = Math.round(rect.top + window.scrollY) - (this.stickyHeight() - half) + extra;
        }
        this.hardScroll(target);

        // ⑤ 补完之后站点偶尔还会把位置改回去（它自己的滚动晚到一步）
        await this.guard(target, landed, alive);
      } finally {
        if (alive()) {                              // 被抢占的那次不许把新任务的状态清掉
          this.running = false;
          this.until = Date.now() + CONFIG.FEATURE.JUMP_GUARD;
        }
      }
    },

    /**
     * 评价分析页签点开之后，站点才会把评论表格渲染出来。
     * 如果上次采集因为「判不出解锁」（当时表格还没渲染）被跳过，这里补一次判断：
     * 只试两次、跑完即止，不轮询、不留后台任务。
     */
    recheckReviews(kind) {
      if (kind !== NAV.REVIEWS) return;
      if (Cards.status.reviews !== 'locked') return;
      [900, 2200].forEach((delay) => {
        setTimeout(() => {
          if (Region.current() !== 'detail') return;
          if (Cards.status.reviews !== 'locked') return;   // 已采到 / 已是别的状态
          Features.refresh(true);
        }, delay);
      });
    },

    /**
     * 落地后看一眼区块标题在哪。
     *
     * 这不是老的「等锚点出现」——那套是每 120ms 轮询、最多等 9 秒、超时弹窗，
     * 卡顿和「没找到好评点」全是它造成的。这里只在页面已经自己滚完之后查一次
     * （实测 1910 个节点、2~3ms），查不到就返回 null，静默退回固定偏移。
     */
    snapTitle(spec) {
      try {
        return Scan.byText(LOC.T[spec.title], { contains: true, maxLen: spec.maxLen })[0] || null;
      } catch (e) {
        return null;
      }
    },

    /**
     * 等站点自己滚完，返回它的落点。
     *
     * 只读 scrollY，不碰 DOM：每 45ms 看一眼「有没有变」，连续 QUIET 毫秒没变就收手。
     * 最早 MIN 毫秒后才允许收手（给 React 一点时间发起滚动），最晚 MAX 毫秒强制收手。
     * 全程一次性 setTimeout 链 + 一个 scroll 监听，结束时两个都撤掉。
     */
    settle() {
      const F = CONFIG.FEATURE;
      return new Promise((resolve) => {
        const started = Date.now();
        let last = Math.round(window.scrollY);
        let lastChange = Date.now();
        let timer = null;

        const onScroll = () => {
          const now = Math.round(window.scrollY);
          if (now !== last) { last = now; lastChange = Date.now(); }
        };
        const finish = () => {
          window.removeEventListener('scroll', onScroll, { passive: true });
          if (timer) clearTimeout(timer);
          resolve(Math.round(window.scrollY));
        };
        const tick = () => {
          const age = Date.now() - started;
          if (age >= F.JUMP_SETTLE_MAX) { finish(); return; }
          if (age >= F.JUMP_SETTLE_MIN && Date.now() - lastChange >= F.JUMP_SETTLE_QUIET) { finish(); return; }
          timer = setTimeout(tick, 45);
        };

        window.addEventListener('scroll', onScroll, { passive: true });
        timer = setTimeout(tick, 45);
      });
    },

    /**
     * 补完偏移后的短观察窗：被站点覆盖就再补一次，最多 2 次。
     * 只在「读数落在站点原始落点附近」时才动手 —— 用户自己拖动了就绝不抢。
     */
    guard(target, landed, alive) {
      return new Promise((resolve) => {
        let fixes = 0;
        let timer = null;
        const onScroll = () => {
          if (alive && !alive()) return;              // 已被抢占 → 绝不把新落点拽回去
          const now = Math.round(window.scrollY);
          if (now === target) return;
          if (Math.abs(now - landed) > 24) return;     // 不是站点把落点改回去，别抢
          if (fixes >= 2) return;
          fixes += 1;
          this.hardScroll(target);
        };
        window.addEventListener('scroll', onScroll, { passive: true });
        timer = setTimeout(() => {
          window.removeEventListener('scroll', onScroll, { passive: true });
          clearTimeout(timer);
          resolve();
        }, CONFIG.FEATURE.JUMP_GUARD);
      });
    },

    /** 一次性跳到位（不用 smooth：平滑滚动在长页面上反而慢，而且要等它结束） */
    hardScroll(top) {
      const target = Math.max(0, Math.round(top));
      try { window.scrollTo({ top: target, behavior: 'instant' }); }
      catch (e) { window.scrollTo(0, target); }
    },

    /**
     * 页签元素。找到一次就记住：React 重渲染会让节点失效，
     * 所以复用前先验 isConnected + 还在布局里，失效了自动重找一遍。
     */
    tabElement(key) {
      const cached = this.tabCache[key];
      if (cached && cached.isConnected && cached.getClientRects().length) return cached;

      const scope = this.tabScope();
      if (!scope) return null;
      const want = Util.norm(LOC.T[key]);
      let hit = null;
      for (const element of scope.querySelectorAll('div,span,button,a,li')) {
        if (Util.norm(element.textContent) !== want) continue;
        if (!element.getClientRects().length) continue;
        hit = element;                            // 取最后一个 = 最内层
      }
      if (hit) this.tabCache[key] = hit;
      return hit;
    },

    /**
     * 详情页的页签栏容器。
     *
     * 必须做这一步隔离：页面顶部的全局导航里也有一个「视频与广告」，和详情页的
     * 页签名一模一样。按文案全局搜会点中顶栏那个 —— 那是真的跳转链接，
     * 一点就把整页带走了（实测页面会直接变成 /video）。
     *
     * 判据：同时含「评价分析」和「视频与广告」两个文案、且整块文字很短（页签栏就那么几个字）。
     * 文字长度这一条是硬保险：顶栏往上爬最后会爬到 <body>，那时两个文案都含在内，
     * 但 body 的文字长度远超上限，直接被排除。
     *
     * 三个种子依次试（前一个找不到才试下一个）：
     *   ① 「核心指标」—— 只有详情页页签栏里才有
     *   ② 页签「视频与广告」—— 顶栏那个往上爬拿不到「评价分析」，自然过不了判据
     *   ③ 页签「评价分析」
     */
    tabScope() {
      const cached = this.scopeCache;
      if (cached && cached.isConnected) return cached;

      const seeds = ['核心指标', LOC.T.tabVideo, LOC.T.tabReviews];
      for (const text of seeds) {
        const seed = Scan.byText(text, { exact: true })[0] ||
                     Scan.byText(text, { contains: true, maxLen: 12 })[0];
        if (!seed) continue;

        let node = seed;
        for (let hop = 0; hop < 8 && node; hop++) {
          if (node === document.body || node === document.documentElement) break;
          const flat = node.textContent || '';
          if (flat.length <= 160 &&
              flat.indexOf(LOC.T.tabReviews) >= 0 &&
              flat.indexOf(LOC.T.tabVideo) >= 0) {
            this.scopeCache = node;
            return node;
          }
          node = node.parentElement;
        }
      }
      return null;
    },

    /** 只在这个作用域里找页签并点它；找不到就返回 false，交给调用方提示 */
    clickTab(key) {
      const hit = this.tabElement(key);
      if (!hit) return false;

      // 绝不能点 <a>：那会把整个页面导航走
      const clickable = hit.closest('button,[role="tab"],li') || hit;
      if (clickable.tagName === 'A') return false;
      try { clickable.click(); } catch (e) { return false; }
      return true;
    },

    /**
     * 常驻条高度。导航条（56）和详情吸顶条（153）是**叠着**的：
     * 后者的 top 正好等于前者的 bottom，所以不能只挑「top ≈ 0」的那一个，
     * 要按 top 从小到大串起来累加。实测结果 209。
     *
     * 量不到（还没渲染 / 被滚出视口）时用上一次的读数兜底，
     * 从没量到过就用 STICKY_FALLBACK —— 宁可差几像素，也不要落到 y=0 被条整块盖住。
     */
    stickyHeight() {
      const bars = [];
      document.querySelectorAll(LOC.S.sticky).forEach((element) => {
        const style = getComputedStyle(element);
        if (style.position !== 'fixed' && style.position !== 'sticky') return;
        const rect = element.getBoundingClientRect();
        if (rect.width < 200 || rect.height < 16) return;
        if (rect.bottom < 20) return;                 // 已经滚出视口
        bars.push({ top: Math.round(rect.top), bottom: Math.round(rect.bottom) });
      });

      bars.sort((a, b) => a.top - b.top);
      let bottom = 0;
      for (const bar of bars) {
        if (bar.top <= bottom + 8) bottom = Math.max(bottom, bar.bottom);
      }
      if (bottom >= 40) { this.lastSticky = bottom; return bottom; }
      return this.lastSticky || CONFIG.FEATURE.STICKY_FALLBACK;
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * §15.5 功能·商品描述 —— 只做一件事：替用户点页面上那个入口
   *
   *  这个入口和两个页签不一样：点它不开新区块，而是弹一个站点自己的
   *  「商品描述预览」弹窗（ant-modal）。所以这里**不跳转、不滚动、不等渲染**，
   *  就是找到元素 → 点一下 → 结束。弹窗什么时候关、怎么关都不归我们管。
   *
   *  两处刻意的设计：
   *    · 优先 XPath：这个按钮没有唯一文案（「商品描述」在页面别处也有），
   *      类名又是 tailwind 拼出来的（flex cursor-pointer items-center gap-1 …），
   *      只有层级是稳定的。XPath 失效才退回文案查找，且必须排除页签栏。
   *    · 连点保护 320ms：连点两下 = 开→关，用户看到的是「点了没反应」。
   *      这段时间里的第二次点击直接忽略，不做队列、不做重试。
   * ═══════════════════════════════════════════════════════════════════════ */

  const Desc = {
    cache: null,        // 找到过的元素（失效自动重找，和页签缓存同一套判据）
    busy: false,        // 320ms 连点保护

    open() {
      if (this.busy) return;

      const target = this.find();
      if (!target) {
        View.toast('没找到「商品描述」入口');
        return;
      }

      this.busy = true;
      setTimeout(() => { this.busy = false; }, CONFIG.FEATURE.DESC_GUARD);

      // 只点一次。样式、开合状态全交给站点，我们不看结果、不校正
      try { target.click(); } catch (e) { /* 元素状态异常就算了，不重试 */ }
    },

    find() {
      const cached = this.cache;
      if (cached && cached.isConnected && cached.getClientRects().length) return cached;

      // ① XPath（§10 的 X 组）
      const byPath = Util.byXPath(LOC.X && LOC.X.descBtn);
      if (byPath && byPath.isConnected && byPath.getClientRects().length) {
        this.cache = byPath;
        return byPath;
      }

      // ② 文案兜底。必须排除页签栏 —— 那里若也有「商品描述」，点它只会切页签
      const scope = Jump.tabScope();
      for (const hit of Scan.byText(LOC.T.desc, { exact: true })) {
        if (scope && scope.contains(hit)) continue;
        const clickable = hit.closest('button,[role="button"]') || hit;
        if (clickable.getClientRects().length) {
          this.cache = clickable;
          return clickable;
        }
      }
      return null;
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * §16  视图·卡片 —— 只读 Cards.data，只写自己那块 DOM
   *  所有可复制的东西都是 [data-copy]，点击由 §7 的委托统一处理，
   *  这里完全不绑定任何监听。
   * ═══════════════════════════════════════════════════════════════════════ */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  const Cards = {
    data: { attrs: [], selling: [], skus: [], reviews: [] },
    status: { attrs: 'loading', selling: 'loading', skus: 'loading', reviews: 'loading' },
    error: {},
    skuOpen: false,          // SKU「展开全部」的开关状态（只在内存里，不落盘）

    render() {
      const host = View.refs && View.refs.cards;
      if (!host) return;
      host.textContent = '';

      host.appendChild(this.buildSelling());
      host.appendChild(this.buildAttrs());
      host.appendChild(this.buildSkus());

      if (this.status.reviews === 'locked') {
        host.appendChild(this.buildTipCard('评价分析', '这个商品的评价还没解锁，已跳过采集（点上方「评价分析」打开页签后再点刷新；或到设置里打开「评价未解锁也采集」）'));
      } else if (this.status.reviews === 'error') {
        host.appendChild(this.buildErrorCard('评论', this.error.reviews));
      } else if (this.status.reviews === 'loading') {
        host.appendChild(this.buildTipCard('评论', '读取中…'));
      } else {
        (this.data.reviews || []).forEach((group) => host.appendChild(this.buildReviewGroup(group)));
      }
    },

    /* ---------- 卖点 ---------- */

    buildSelling() {
      const list = this.data.selling || [];
      const card = el('div', 'card');
      card.setAttribute('data-sec', 'selling');       // 本栏内跳转的落点（回到顶部）
      const head = el('div', 'card-head');
      head.appendChild(el('span', null, '卖点'));
      if (list.length) head.appendChild(el('span', 'n', String(list.length)));
      card.appendChild(head);

      if (this.status.selling === 'loading') { card.appendChild(el('div', 'card-empty', '读取中…')); return card; }
      if (!list.length) { card.appendChild(el('div', 'card-empty', '没找到卖点')); return card; }

      // 整张卡片都是「复制全部卖点」的点击区：chip 自己带 data-copy 盖住它（点单条→复制单条），
      // 点卡片其余空白（标题行、chip 之间的缝、卡片内边距）→ closest 落到 card，复制全部。
      card.setAttribute('data-copy', list.join('\n'));
      card.title = '点击卡片空白处复制全部 ' + list.length + ' 条卖点';

      const chips = el('div', 'chips');
      list.forEach((text) => {
        const chip = el('span', 'chip', text);
        chip.setAttribute('data-copy', text);
        chip.title = '点击复制「' + text + '」';
        chips.appendChild(chip);
      });
      card.appendChild(chips);
      return card;
    },

    /* ---------- 属性 ---------- */

    buildAttrs() {
      const list = this.data.attrs || [];
      const card = el('div', 'card');
      const head = el('div', 'card-head');
      head.appendChild(el('span', null, '商品属性'));
      if (list.length) head.appendChild(el('span', 'n', String(list.length)));
      card.appendChild(head);

      if (this.status.attrs === 'loading') { card.appendChild(el('div', 'card-empty', '读取中…')); return card; }
      if (!list.length) { card.appendChild(el('div', 'card-empty', '没找到属性')); return card; }

      list.forEach((item) => {
        const row = el('div', 'attr');
        row.appendChild(el('span', 'k', item.label));

        // 显示用原文，复制用 item.copy（容量类属性只留数字，见 Collect.copyOf）
        const payload = item.copy == null ? item.value : item.copy;
        const value = el('span', 'v' + (item.priority ? ' prio' : ''), item.value);
        value.setAttribute('data-copy', payload);
        value.title = payload === item.value
          ? '点击复制：' + item.value
          : '点击复制：' + payload + '（原文 ' + item.value + '）';
        row.appendChild(value);
        card.appendChild(row);
      });
      return card;
    },

    /* ---------- SKU ---------- */

    buildSkus() {
      const list = this.data.skus || [];
      const card = el('div', 'card');
      const head = el('div', 'card-head');
      head.appendChild(el('span', null, 'SKU'));
      if (list.length) head.appendChild(el('span', 'n', String(list.length)));
      card.appendChild(head);

      if (this.status.skus === 'loading') { card.appendChild(el('div', 'card-empty', '读取中…')); return card; }
      if (this.status.skus === 'error') {
        card.appendChild(el('div', 'card-err', this.error.skus || '接口失败'));
        return card;
      }
      if (!list.length) { card.appendChild(el('div', 'card-empty', '没找到 SKU')); return card; }

      /**
       * 收纳：默认只露前 SKU_VISIBLE 条，其余在「展开全部 N 条」后面。
       *  · 顺序 = 接口原始顺序 = 网页上的显示顺序，不做任何重排（不做排序，避免和网页对不上号）
       *  · 多余的行**根本不建 DOM**，点开时才建；收起时直接清掉，不留隐藏节点
       *  · 没有常驻监听：按钮自己带一个 click，展开/收起就重建这几十行，一次性的
       */
      const limit = Math.max(1, Number(CONFIG.FEATURE.SKU_VISIBLE) || 3);
      let open = this.skuOpen === true;
      const body = el('div', 'sku-body');
      card.appendChild(body);

      const fill = () => {
        body.textContent = '';                       // 重建而不是藏着，收起时不占 DOM
        const count = open ? list.length : Math.min(limit, list.length);
        for (let index = 0; index < count; index += 1) body.appendChild(this.skuRow(list[index], index));
      };
      fill();

      if (list.length > limit) {
        const more = el('button', 'sku-more');
        more.type = 'button';
        const sync = () => {
          more.textContent = open ? '收起' : '展开全部 ' + list.length + ' 条';
          more.classList.toggle('is-open', open);
        };
        sync();
        more.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();                   // 别让点击冒泡到卡片的复制委托
          open = !open;
          this.skuOpen = open;
          fill();
          sync();
        });
        card.appendChild(more);
      }

      return card;
    },

    /**
     * 单个 SKU 行：缩略图 / 名称 / 价格，再铺两个 50% 宽的点击区。
     *   左半：复制容量（从名字里剥纯数字，`【500ml】` → `500`）
     *   右半：复制价格（老行为）
     * 点击区盖在内容之上，所以「点名字」和「点价格」都由落点决定，不用判断元素。
     */
    skuRow(item, index) {
      const row = el('div', 'sku');
      const number = this.priceNumber(item.price);
      const capacity = this.capacityOf(item.name);

      if (item.img) {
        const thumb = el('span', 'thumb');
        const image = document.createElement('img');
        image.src = item.img;
        image.alt = '';
        image.loading = 'lazy';
        thumb.appendChild(image);
        row.appendChild(thumb);
      } else {
        row.appendChild(el('span', 'thumb ph', '无图'));
      }

      const name = el('span', 'nm', item.name);
      name.title = item.name;
      row.appendChild(name);

      row.appendChild(el('span', 'pr', item.price || '—'));

      // 左半：有容量 → 蓝底、复制容量；没容量 → 红底（跟价格同色）、复制金额。
      // 两边永远不合并，颜色只是「这一格复制的是什么」的提示。
      const left = el('span', 'half l' + (capacity ? '' : ' alt'));
      left.setAttribute('data-copy', capacity || number);
      left.title = (capacity ? '点击复制容量：' + capacity : '点击复制价格：' + (number || '—'));

      // 右半：价格（永远是价格）
      const right = el('span', 'half r');
      right.setAttribute('data-copy', number);
      right.title = '点击复制价格：' + (number || '—');

      row.appendChild(left);
      row.appendChild(right);

      return row;
    },

    /**
     * 从 SKU 名字里剥容量数字：`【500ml】` → `500`、`2kg` → `2`、`30片` → `30`。
     * 必须「数字紧跟单位」才算命中 —— 否则 `2 trong 1` 这种序号会被误当容量。
     * 剥不出来返回空串，调用方负责提示（不猜、不复制名字）。
     */
    capacityOf(name) {
      const matched = String(name || '')
        .match(/(\d+(?:[.,]\d+)?)\s*(ml|毫升|cl|mg|毫克|g|克|kg|千克|l|升|litre|liter|oz|盎司|片|粒|包|袋|瓶|支)/i);
      return matched ? matched[1].replace(',', '.') : '';
    },

    /** "¥22.51" → "22.51"；带千分位也能剥干净 */
    priceNumber(raw) {
      const text = String(raw || '').replace(/,/g, '');
      const matched = text.match(/\d+(?:\.\d+)?/);
      return matched ? matched[0] : text.trim();
    },

    /* ---------- 评论 ---------- */

    buildReviewGroup(group) {
      const card = el('div', 'card');
      // 好评点 / 吐槽点各打一个落点，供跳转条下行的两个按钮用（见 View.scrollToSection）
      const sec = group.key === 'positivePoints' ? 'good' : (group.key === 'painPoints' ? 'bad' : '');
      if (sec) card.setAttribute('data-sec', sec);
      const head = el('div', 'card-head');
      head.appendChild(el('span', null, group.title));
      // 刻意不显示「共 N 条 / 还有 N 条」：评论区是只读的，不给任何暗示「还有更多」的入口
      card.appendChild(head);

      const points = group.points || [];
      if (!points.length) { card.appendChild(el('div', 'card-empty', '暂无')); return card; }

      points.forEach((point) => {
        const wrap = el('div', 'pt');
        const title = el('div', 'pt-h');

        /* 标题 + 占比是**两个独立的点击区**，各自把 payload 写在 data-copy 上，
           由 §7 的点击委托统一处理（点标题复制标题，点百分比复制百分比）。
           排版：标题居左、占比居右（见 .pt-h 的 space-between），同一行、同一套字体。 */
        const name = el('span', null, point.point || '未命名观点');
        name.setAttribute('data-copy', point.point || '未命名观点');
        title.appendChild(name);

        if (point.rate) {
          const pct = el('i', null, point.rate);
          pct.setAttribute('data-copy', point.rate);
          title.appendChild(pct);
        }
        wrap.appendChild(title);

        const list = el('ul');
        point.lines.forEach((line) => {
          // 兼容两种形态：老数据是纯字符串（当 5 星），新数据是 {text, star}
          const isObject = line && typeof line === 'object';
          const node = el('li', null, isObject ? line.text : line);
          // 只有 1~4 星才打标记：5 星是绝大多数，保持原来的小圆点不动
          const star = isObject ? line.star : 5;
          if (star >= 1 && star <= 4) node.setAttribute('data-star', String(star));
          list.appendChild(node);
        });
        wrap.appendChild(list);
        card.appendChild(wrap);
      });
      return card;
    },

    buildTipCard(title, text) {
      const card = el('div', 'card');
      const head = el('div', 'card-head');
      head.appendChild(el('span', null, title));
      card.appendChild(head);
      card.appendChild(el('div', 'card-empty', text));
      return card;
    },

    buildErrorCard(title, message) {
      const card = el('div', 'card');
      const head = el('div', 'card-head');
      head.appendChild(el('span', null, title));
      card.appendChild(head);
      card.appendChild(el('div', 'card-err', message || '接口失败'));
      return card;
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * §17  视图·设置 —— 展示界面 ⇄ 设置界面，互斥
   *
   *  两套输入，同一个 draft：
   *    ① 分组表单：一行一项，左边中文名、右边值。可读性优先，日常改这个。
   *    ② 原始 JSON：给「整段替换」用（比如 AI 返回一份配置，直接粘进来）。
   *  点「应用」才写 localStorage —— 表单里改一半反悔，退出设置界面就丢掉，不会污染现场。
   *
   *  「复制提示词」把「页面事实 + 当前配置 + 跳转算法 + 输出格式」打包成一段话，
   *  连同 9222 端口的用法一起交出去，外部 AI 拿到就能直接量、直接改、直接回一份 JSON。
   * ═══════════════════════════════════════════════════════════════════════ */

  /* ═══════════════════════════════════════════════════════════════════════
   * §16.5 定位体检 —— 回答一个问题：「现在哪一项抓不到了」
   *
   *  站点改版时，面板通常只坏一两项（比如 SKU 价格空了、属性行没了）。
   *  这里把每个定位项的健康状况一次性摊开：
   *     anchors   每个文本锚点 T 命中几个元素
   *     selectors 每个选择器 S 命中几个节点
   *     apis      每个接口的完整地址（JSON 里只有 path，前缀写死在 LOC.post）
   *     collected 最近一次采集各项拿到多少（0 = 那一项挂了）
   *
   *  两个使用方：
   *    · KDS_SPLIT.probe()   —— 外部 AI / 控制台直接看
   *    · §17 的「复制提示词」—— 把同一份数据摘要塞进提示词，AI 拿到时就有现场
   *  这里只读不写，不产生副作用，可以随便调。
   * ═══════════════════════════════════════════════════════════════════════ */

  const Diagnostics = {
    probe() {
      // 注意：querySelectorAll 返回的是 NodeList，不是 Array —— 不能只判 Array.isArray，
      // 否则会把整个 NodeList 原样带进返回值（里面有 React fiber，JSON 序列化会直接爆循环引用）。
      const countOf = (fn) => {
        try {
          const value = fn();
          if (value == null) return 0;
          if (typeof value === 'number') return value;
          if (typeof value.length === 'number') return value.length;
          return value ? 1 : 0;
        } catch (e) { return 'ERR:' + String((e && e.message) || e).slice(0, 60); }
      };

      const anchors = {};
      Object.keys(LOC.T).forEach((key) => {
        anchors[key] = {
          text: LOC.T[key],
          desc: (LOC_LABEL.T.items && LOC_LABEL.T.items[key]) || '',
          hits: countOf(() => Scan.byText(LOC.T[key], { contains: true, maxLen: 24 }))
        };
      });

      const selectors = {};
      Object.keys(LOC.S).forEach((key) => {
        selectors[key] = {
          selector: LOC.S[key],
          desc: (LOC_LABEL.S.items && LOC_LABEL.S.items[key]) || '',
          hits: countOf(() => document.querySelectorAll(LOC.S[key]))
        };
      });

      const xpaths = {};
      Object.keys(LOC.X).forEach((key) => {
        xpaths[key] = {
          path: LOC.X[key],
          desc: (LOC_LABEL.X.items && LOC_LABEL.X.items[key]) || '',
          hits: countOf(() => Util.byXPath(LOC.X[key]))
        };
      });

      const apis = {};
      Object.keys(LOC.API).forEach((key) => {
        apis[key] = {
          path: LOC.API[key],
          url: 'https://www.kalodata.com' + LOC.API[key],
          desc: (LOC_LABEL.API.items && LOC_LABEL.API.items[key]) || ''
        };
      });

      const data = Cards.data;
      const reviews = (data.reviews || []).reduce(
        (sum, group) => sum + group.points.reduce((n, point) => n + point.lines.length, 0), 0);

      return {
        url: location.href,
        productId: LOC.productId(),
        collected: {
          attrs: data.attrs.length,        // 看 selectors.attrRow / attrLabel / attrValue
          selling: data.selling.length,    // 看 anchors.selling + selectors.chip
          skus: data.skus.length,          // 看 apis.skuAnalysis
          reviews                          // 看 apis.insight + apis.insightDetail
        },
        status: Object.assign({}, Cards.status),
        errors: Object.assign({}, Cards.error),
        anchors,
        selectors,
        xpaths,
        apis,
        jump: Object.assign({}, LOC.JUMP),
        numeric: LOC.NUMERIC.slice(),     // 哪些属性只复制数字（显示不受影响）
        hint: 'hits=0 / collected=0 / status=error 的那一项就是要修的：文本锚点先换文案，选择器先换类名，' +
          'XPath 先看层级，接口先核对 path'
      };
    },

    /** 一行摘要（塞进提示词用，别把整份 probe 倒进去） */
    brief() {
      const p = this.probe();
      const hits = {};
      Object.keys(p.anchors).forEach((key) => { hits['T.' + key] = p.anchors[key].hits; });
      Object.keys(p.selectors).forEach((key) => { hits['S.' + key] = p.selectors[key].hits; });
      Object.keys(p.xpaths || {}).forEach((key) => { hits['X.' + key] = p.xpaths[key].hits; });

      const out = { id: p.productId, collected: p.collected, status: p.status, hits };
      if (p.numeric && p.numeric.length) out.numeric = p.numeric;

      // 只带非空的错误，空对象不占篇幅
      const errors = {};
      Object.keys(p.errors || {}).forEach((key) => {
        const value = p.errors[key];
        if (value) errors[key] = String(value);
      });
      if (Object.keys(errors).length) out.errors = errors;
      return out;
    }
  };

  /** 设置界面里每一项的中文名（key 必须与 §10 的定位表一一对应） */
  const LOC_LABEL = {
    T: {
      title: '文本锚点', hint: '页面上那几行字',
      items: {
        more: '「更多」按钮', tabVideo: '页签·视频与广告', tabReviews: '页签·评价分析',
        good: '好评点标题', voice: '表头·客户原声', video: '表头·视频内容',
        selling: '卖点行标签', desc: '「商品描述」入口'
      }
    },
    S: {
      title: 'CSS 选择器', hint: '文案变了才用得上',
      items: { attrRow: '属性行', attrLabel: '属性名', attrValue: '属性值', chip: '卖点芯片', sticky: '顶部常驻条' }
    },
    X: {
      title: 'XPath 定位', hint: '按层级找，前两条都失效才用',
      items: { descBtn: '商品描述按钮' }
    },
    API: {
      title: '接口路径', hint: '评论 / SKU 走接口',
      items: { insight: '好评点·吐槽点', insightDetail: '观点下的评论', skuAnalysis: 'SKU 列表' }
    }
  };

  const Debug = {
    draft: null,

    toggle() {
      const next = Store.state.view === 'debug' ? 'show' : 'debug';
      Store.patch({ view: next });
      if (next === 'debug') this.prefill();
    },

    prefill() {
      const refs = View.refs;
      if (!refs || !refs.dbgForm) return;
      try { this.draft = JSON.parse(LOC.dump()); } catch (e) { this.draft = null; }
      if (refs.optCollapse) refs.optCollapse.checked = !!Store.state.autoCollapse;
      if (refs.optBlockNet) refs.optBlockNet.checked = Store.state.blockNet !== false;
      if (refs.optForceReview) refs.optForceReview.checked = !!Store.state.forceReviews;
      View.syncAlpha(Store.state.alpha);
      this.netHint();
      this.renderForm();
      this.renderJson();
      this.status();
    },

    /** 按 §10 的分组，把定位表铺成「一行一项」 */
    renderForm() {
      const box = View.refs && View.refs.dbgForm;
      if (!box || !this.draft) return;
      box.textContent = '';

      ['T', 'S', 'X', 'API'].forEach((group) => {
        const meta = LOC_LABEL[group];
        const card = el('div', 'grp');
        const head = el('div', 'grp-h');
        head.appendChild(el('span', null, meta.title));
        head.appendChild(el('em', null, meta.hint));
        card.appendChild(head);

        Object.keys(this.draft[group] || {}).forEach((key) => {
          const row = el('label', 'fld');
          row.appendChild(el('span', 'k', meta.items[key] || key));
          row.appendChild(this.field(group + '.' + key, this.draft[group][key]));
          card.appendChild(row);
        });
        box.appendChild(card);
      });

      const card = el('div', 'grp');
      const head = el('div', 'grp-h');
      head.appendChild(el('span', null, '属性置顶'));
      head.appendChild(el('em', null, '逗号分隔，命中就排前面'));
      card.appendChild(head);
      const row = el('label', 'fld');
      row.appendChild(el('span', 'k', '关键词'));
      row.appendChild(this.field('PRIORITY', (this.draft.PRIORITY || []).join('，')));
      card.appendChild(row);
      box.appendChild(card);

      // 纯数字复制：只影响「点一下复制什么」，显示永远是原文
      const numCard = el('div', 'grp');
      const numHead = el('div', 'grp-h');
      numHead.appendChild(el('span', null, '纯数字复制'));
      numHead.appendChild(el('em', null, '这些属性只复制数字，显示不变'));
      numCard.appendChild(numHead);
      const numRow = el('label', 'fld');
      numRow.appendChild(el('span', 'k', '关键词'));
      numRow.appendChild(this.field('NUMERIC', (this.draft.NUMERIC || []).join('，')));
      numCard.appendChild(numRow);
      box.appendChild(numCard);

      this.syncJump();
    },

    field(path, value) {
      const input = el('input', 'v');
      input.type = 'text';
      input.value = value == null ? '' : String(value);
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.setAttribute('data-loc', path);
      return input;
    },

    /** 跳转偏移那两格（在静态标记里，不走动态表单） */
    syncJump() {
      const root = View.refs && View.refs.viewDebug;
      if (!root || !this.draft) return;
      const jump = this.draft.JUMP || {};
      ['reviews', 'video'].forEach((key) => {
        const input = root.querySelector('[data-jump="' + key + '"]');
        if (input) input.value = String(Number(jump[key]) || 0);
      });
    },

    renderJson() {
      const node = View.refs && View.refs.dbgJson;
      if (node && this.draft) node.value = JSON.stringify(this.draft, null, 1);
    },

    /** 表单/JSON 任何一格被改动：只写 draft，点「应用」才生效 */
    input(field) {
      if (!this.draft) return;

      const jumpKey = field.getAttribute('data-jump');
      if (jumpKey) {
        const value = Number(String(field.value).replace(/[^\d-]/g, ''));
        this.draft.JUMP = this.draft.JUMP || {};
        this.draft.JUMP[jumpKey] = isFinite(value) ? Math.round(value) : 0;
        this.renderJson();
        return;
      }

      const path = field.getAttribute('data-loc');
      if (!path) return;
      if (path === 'PRIORITY' || path === 'NUMERIC') {
        this.draft[path] = String(field.value)
          .split(/[,，、;；\s]+/).map((part) => part.trim()).filter(Boolean);
      } else {
        const pair = path.split('.');
        if (!this.draft[pair[0]]) return;
        this.draft[pair[0]][pair[1]] = String(field.value);
      }
      this.renderJson();
    },

    /** 原始 JSON 合法就回灌表单；输入中间态不合法就静静等着，不弹错 */
    fromJson() {
      const node = View.refs && View.refs.dbgJson;
      if (!node) return;
      let parsed = null;
      try { parsed = JSON.parse(node.value); } catch (e) { return; }
      if (!parsed || typeof parsed !== 'object') return;
      this.draft = parsed;
      this.renderForm();
    },

    status(extra) {
      const node = View.refs && View.refs.dbgStat;
      if (!node) return;
      if (extra) { node.textContent = extra; return; }
      const data = Cards.data;
      const reviews = (data.reviews || []).reduce(
        (sum, group) => sum + group.points.reduce((n, point) => n + point.lines.length, 0), 0);
      node.textContent = '卖点 ' + data.selling.length + ' · 属性 ' + data.attrs.length +
        ' · SKU ' + data.skus.length + ' · 评论 ' + reviews + ' 条 · 常驻条 ' + Jump.stickyHeight() + 'px' +
        ' · 拦截 ' + NetGuard.hits;
    },

    /** 网络闸那一行的小字：说明「改了要刷新」并把本次实际拦截数摆出来 */
    netHint() {
      const node = View.refs && View.refs.netHint;
      if (!node) return;
      const on = Store.state.blockNet !== false;
      node.textContent = on
        ? '（本次已拦 ' + NetGuard.hits + ' 个请求，改动需刷新生效）'
        : '（已关闭，改动需刷新生效）';
    },

    apply() {
      if (!this.draft) return;
      Util.writeJSON(CONFIG.LOC_KEY, this.draft);
      LOC.load();
      this.prefill();
      View.toast('已应用，正在重新采集');
      Features.refresh(true);
    },

    action(name) {
      if (name === 'collect') { Features.refresh(true); return; }

      if (name === 'copyCfg') { Clip.copy(LOC.dump(), '配置 JSON'); return; }

      if (name === 'copyPrompt') { Clip.copy(this.buildPrompt(), '提示词'); return; }

      if (name === 'apply') { this.apply(); return; }

      if (name === 'reset') {
        Util.removeKey(CONFIG.LOC_KEY);
        LOC.load();
        this.prefill();
        View.toast('已恢复默认定位');
        Features.refresh(true);
      }
    },

    /**
     * 给外部 AI 的「定位修复」提示词。
     *
     * 目的只有一个：让它能把坏掉的定位修回来。
     * 所以只交代三件事 —— 现场怎么连、这份 JSON 每一项管什么、哪一项坏了怎么查。
     * 页面宽度 / 缩放 / 广告截断这些东西与定位无关，一律不写进来（写了只会分散注意力）。
     */
    buildPrompt() {
      let brief = null;
      try { brief = Diagnostics.brief(); } catch (e) { brief = null; }
      const briefText = brief ? JSON.stringify(brief) : '(体检数据取不到，请先跑 KDS_SPLIT.probe())';
      const headers = LOC.headers();

      return [
        '# Kalodata 面板 · 定位修复',
        '',
        '## 任务',
        '下面这份 JSON 是面板「从页面上 / 接口里找数据」的全部配置。现在有一项失效了（见「我看到的问题」）。',
        '请只修失效的那几项，输出一份可直接粘回去的**完整** JSON。',
        '你的目标不是让配置好看，而是让面板重新抓到数据 —— 判断标准是 KDS_SPLIT.probe() 里对应数字不再是 0。',
        '',
        '## 环境（连上就能用）',
        '- Edge 已开调试端口：http://127.0.0.1:9222',
        '- 列目标：`curl -s http://127.0.0.1:9222/json/list`，挑 type=page 且 url 含 kalodata.com/product/detail 的那条。',
        '- 执行表达式：在脚本目录的 `tools` 里跑 `node cdp.mjs "<一条 JS 表达式>"`（awaitPromise 已开，返回值直接打印）。',
        '- 页面里脚本已就位，这些句柄可直接用：',
        '    KDS_SPLIT.probe()      ★ 先跑这个：一次列出所有定位项的命中数（哪项是 0 一目了然）',
        '    KDS_SPLIT.loc()        当前 JSON（与下面粘贴的那份一致）',
        '    KDS_SPLIT.collect()    重新采集一次，返回各项数量',
        '    KDS_SPLIT.jump("reviews") / jump("video")   触发一次跳转',
        '    KDS_SPLIT.desc()       点一次页面上的「商品描述」入口（会开弹窗）',
        '    KDS_SPLIT.net()        网络闸状态（与本任务无关，别动它）',
        '',
        '## 这是什么页面',
        '- kalodata 的商品详情页（东南亚电商数据）。右边是站点页面，左边是脚本自建的面板（shadow DOM）。',
        '- 面板的数据只有两个来源，所以「失效」也只有两种形态：',
        '    A 页面 DOM —— 商品属性、卖点芯片、商品描述入口  → 靠 T 文本锚点 / S 选择器 / X XPath',
        '    B 站点接口 —— SKU 列表、评论                    → 靠 API 路径',
        '- 站点是 React 单页应用，区块分批渲染；「评价分析」「视频与广告」是两个页签，要点一下内容才出来。',
        '- 站点接口必须带三个自定义请求头 country / currency / language（值从地址栏的 region / currency / language 取），',
        '  缺任何一个都返回 {"success":false,"message":"file not found"} —— 这个坑踩过，别怀疑。',
        '',
        '## 这份 JSON 的格式（先读完这段，再动值）',
        '- 它是这份配置的**完整当前值**（脚本内置默认 + 本地覆盖合并后的结果），不是差异；你输出的也必须是完整一份。',
        '',
        '**T（文本锚点）** —— 页面上那行字。命中率最高，站点改版一般不动文案，**恢复定位优先改这里**',
        '    more        各区块的「更多」按钮（点完会变「收起」，用于自动展开）',
        '    tabVideo    页签「视频与广告」（点它就是跳转本身）',
        '    tabReviews  页签「评价分析」',
        '    good        评价分析里的区块标题「好评点」（页面上实际带 emoji 前缀）—— 只用于算跳转落点',
        '    video       视频表格的表头列名「视频内容」—— 只用于算跳转落点',
        '    selling     卖点那一行的左侧标签「卖点」',
        '    desc        「商品描述」入口的文案（只在 X.descBtn 失效时兜底，会排除页签栏里的同名项）',
        '    （good / video 抓不到不会报错，跳转会退回「站点落点 + JUMP 偏移」，只是位置差一点）',
        '',
        '**S（CSS 选择器）** —— T 找不到时的备用路线',
        '    attrRow     一个属性行的容器（一行 = 属性名 + 属性值）',
        '    attrLabel   属性名所在的元素',
        '    attrValue   属性值所在的元素',
        '    chip        卖点芯片（圆角小标签）',
        '    sticky      顶部常驻条（只用于体检报告里报高度，跳转不依赖它）',
        '',
        '**X（XPath）** —— 按层级定位，只在「没有唯一文案、类名又是 tailwind 拼出来的」时用',
        '    descBtn     「商品描述」按钮。点它会弹站点的 ant-modal「商品描述预览」，面板不接管这个弹窗。',
        '                这是绝对路径，站点一改层级就 hits=0 —— 修的时候优先换成 T.desc 的文案，或重新取一条更短的 XPath',
        '',
        '**API（接口路径）** —— JSON 里只有 path，**完整地址 = https://www.kalodata.com + path**（前缀写死在脚本 LOC.post 里）',
        '    insight         好评点 / 吐槽点列表',
        '    insightDetail   某个观点下的评论（带中文翻译）',
        '    skuAnalysis     SKU 名称 / 价格 / 销量占比',
        '',
        '**PRIORITY（属性排序）** —— 这些关键词的属性排到最前。只影响显示顺序，不影响能不能抓到。',
        '',
        '**NUMERIC（纯数字复制）** —— 属性名命中这些关键词时，点击只把**数字**放进剪贴板，',
        '显示的文字仍然是页面原文。例如「净含量 500毫升」点击复制 `500`，「规格 50ml」复制 `50`。',
        '只影响复制内容，不影响采集、显示和排序。剥不出数字时退回原文。',
        '',
        '**JUMP（落点偏移）** —— 点完页签后，在「站点自己滚到的位置」上再多滚多少 px（整数；正数 = 继续往下）。',
        '只影响滚动位置，不影响抓取。跳转本身不查任何文字，所以它坏了不是定位问题。',
        '',
        '## 改了 JSON 也修不好、必须动脚本的部分',
        '如果排查下来发现毛病不在上面这些值里，那就是这几处（都在脚本里，不在 JSON 里）：',
        '    · 接口完整地址的前缀 https://www.kalodata.com          → 在 LOC.post()',
        '    · 三个请求头 country / currency / language             → 在 LOC.headers()',
        '    · 商品 id 从地址栏 ?id= 取                              → 在 Gate.productId()',
        '    · 属性点击时复制什么（原文 / 纯数字）                    → 在 §11 Collect.copyOf()',
        '    · 面板里数据怎么拼装、怎么渲染                          → 在 §11 采集层 / §16 卡片',
        '这种情况请直接说明「要改脚本」，并写清函数名和那一行的新旧值，不要硬凑 JSON。',
        '',
        '## 现场（脚本自动填，就是你连上去看到的状态）',
        '- URL：' + location.href,
        '- 商品 id：' + LOC.productId(),
        '- probe：' + briefText,
        '',
        '## 我看到的问题',
        '（这一行是我写的，例如：SKU 的价格读不到了 / 商品属性是空的 / 好评点没有内容 / 属性名字和值串了）',
        '<<< 在这里写你看到的现象 >>>',
        '',
        '## 怎么修（按这个顺序，别跳步）',
        '1. 跑 `node cdp.mjs "KDS_SPLIT.probe()"`，看 anchors / selectors / xpaths 里哪一项 hits=0，或 collected 里哪项是 0，',
        '   或 status 里哪项是 error（error 信息在 errors 里）。',
        '2. 坏的是 **T（文本锚点）**：在页面上找它的替代文案（注意页面上可能有同名多处，比如顶栏也有「视频与广告」，',
        '   要挑详情区块里那个）：',
        '   `node cdp.mjs "[...document.querySelectorAll(\'div,span,button,td,th\')].filter(e=>e.children.length===0&&/关键词/.test(e.textContent)).slice(0,12).map(e=>e.textContent.trim().slice(0,40))"`',
        '3. 坏的是 **S（选择器）**：看结构改成什么样了（类名 / 层级）：',
        '   `node cdp.mjs "[...document.querySelectorAll(\'div\')].filter(e=>/关键词/.test(e.textContent)&&e.children.length<6).slice(0,8).map(e=>e.className).filter(Boolean)"`',
        '4. 坏的是 **X（XPath）**：先看这个按钮还在不在、文案变没变（点开控制台高亮一下最直观）：',
        '   `node cdp.mjs "(()=>{const n=document.evaluate(\'//*[@id=\\"root\\"]//button[contains(.,\\"商品描述\\")]\',document,null,9,null).singleNodeValue;return n?n.outerHTML.slice(0,200):\'NOT FOUND\'})()"`',
        '   还在就直接把 T.desc 填对（文案查找优先），X 只作兜底；真要用 XPath 就取一条尽量短的相对路径。',
        '5. 坏的是 **API（接口）**：先直连接口验证 path 对不对（把 skuAnalysis 换成要试的 path，id 就填当前商品）：',
        '   `node cdp.mjs "fetch(\'/product/detail/skuAnalysis\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\',country:\'' +
          headers.country + '\',currency:\'' + headers.currency + '\',language:\'' + headers.language +
          '\'},body:JSON.stringify({id:\'' + LOC.productId() + '\',authority:true})}).then(r=>r.text()).then(t=>t.slice(0,300))"`',
        '   有数据 → path 或参数变了；回 file not found → 路径和请求头都可能不对。',
        '6. 改完验证：把 JSON 粘回设置界面的「原始 JSON」→ 点「应用」→ 再跑一次 probe()，对应数字应该回来。',
        '',
        '## 当前配置（这就是要改的那份，完整）',
        '```json',
        LOC.dump(),
        '```',
        '',
        '## 输出格式',
        '1. 一个 ```json 代码块：完整配置，**保留全部 key**（T / S / X / API / PRIORITY / NUMERIC / JUMP），不加注释、不删字段。',
        '2. 「改了什么」：每条 ≤ 20 字，说明改成什么、为什么。',
        '3. 「要动脚本吗」：只有 JSON 修不了时才写，格式 `函数名：旧值 → 新值`。',
        ''
      ].join('\n');
    }
  };

  /* ═══════════════════════════════════════════════════════════════════════
   * §18  装配 —— 把「什么时候做什么」集中成一条时间线
   *
   *  刷新后的动作顺序（只有这一次，之后全靠点击驱动）：
   *    ① 「更多」→「收起」   有限等待 10 秒，撞到就停
   *    ② 等详情渲染出来      有限等待 20 秒，拿到即走
   *    ③ 采集 DOM 数据       同步，几乎零成本
   *    ④ 拉接口（SKU/评论）  并行，失败单独降级
   * ═══════════════════════════════════════════════════════════════════════ */

  const Features = {
    running: false,

    start() {
      LOC.load();
      More.awaitAndClick();

      // 探针只数节点，不解析内容：这个判断在 DOM 每次变动后都会跑，
      // 而 Collect.attrs() 要取文本、剥数字、排序，贵一个数量级。
      // 等「出现了」再让 refresh 去解析一遍，结果一样，探针成本几乎为零。
      Wait.until(() => document.querySelectorAll(LOC.S.attrRow).length > 0, CONFIG.FEATURE.COLLECT_WAIT, 400)
        .then(() => {
          this.refresh(false);
          More.awaitAndClick(6000);       // 详情渲染完可能才冒出新的「更多」，再补一个窗口
        });
    },

    async refresh(force) {
      // 同文档内已经路由到别的页了就别再拉接口（旧商品 id 会拉回一堆没人看的数据）
      if (this.running || Region.current() !== 'detail') return;
      this.running = true;
      try {
        Cards.status = { attrs: 'loading', selling: 'loading', skus: 'loading', reviews: 'loading' };
        Cards.render();

        // ① DOM 部分：快、稳、几乎零成本
        Cards.data.attrs = Collect.attrs();
        Cards.data.selling = Collect.selling();
        Cards.status.attrs = 'done';
        Cards.status.selling = 'done';
        Cards.render();

        // ② 接口部分：两条独立流水线，谁先回来谁先上屏。
        //    评论要先看页面判断解锁（§11.0 有界等待，最坏 7 秒），
        //    所以不能再和 SKU 绑在一个 Promise.all 里 —— 否则 SKU 白等整整一段。
        const reuseReviews = !force && (Cards.data.reviews || []).length > 0;

        const skuTask = Collect.skus()
          .then((value) => ({ value }))
          .catch((error) => ({ error }));

        const reviewTask = reuseReviews
          ? Promise.resolve({ value: Cards.data.reviews })
          : Collect.reviews()
            .then((value) => ({ value }))
            .catch((error) => ({ error }));

        const skuResult = await skuTask;
        if (skuResult.error) {
          Cards.status.skus = 'error';
          Cards.error.skus = skuResult.error.message;
          Cards.data.skus = [];
        } else {
          Cards.status.skus = 'done';
          Cards.data.skus = skuResult.value || [];
        }
        Cards.render();

        const reviewResult = await reviewTask;
        if (reviewResult.error && reviewResult.error.kdsLocked) {
          Cards.status.reviews = 'locked';          // 未解锁 —— 不是错误，是一种正常状态
          Cards.error.reviews = '';
          Cards.data.reviews = [];
        } else if (reviewResult.error) {
          Cards.status.reviews = 'error';
          Cards.error.reviews = reviewResult.error.message;
          Cards.data.reviews = [];
        } else {
          Cards.status.reviews = 'done';
          Cards.data.reviews = reviewResult.value || [];
        }

        Cards.render();
        Debug.status();
        More.click();          // 数据都回来了，页签里的「更多」这时候基本都在
      } finally {
        this.running = false;
      }
    }
  };

  App.init();
})();
