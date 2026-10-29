/* 在真实 Coze 页面里抓取消息区域的 DOM 层级，用于精确适配。
   用法：把本文件内容粘贴到 DevTools Console（注意要切到 iframe 上下文），
   或按 F12 → 顶部上下文下拉里选 ui-builder-app 那一项。
*/
(function () {
  // 找到包含「课程答题智能体」或题目文字的最近公共祖先附近的结构
  function findAnchor() {
    const all = [...document.querySelectorAll('div, section, article')];
    return all.find((el) => {
      const t = el.innerText || '';
      return t.length > 30 && t.length < 3000 && /考查知识点|异步|判断题|单选题/.test(t);
    }) || null;
  }

  function describe(el, depth, maxDepth) {
    if (!el || depth > maxDepth) return null;
    const r = el.getBoundingClientRect();
    const kidEls = [...el.children].filter((c) => {
      const cr = c.getBoundingClientRect();
      return cr.width > 0 && cr.height > 0;
    });
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      cls: (el.className || '').toString().split(/\s+/).slice(0, 3).join('.'),
      w: Math.round(r.width),
      h: Math.round(r.height),
      textLen: (el.innerText || '').length,
      textHead: (el.innerText || '').trim().slice(0, 50).replace(/\n/g, ' ⏎ '),
      kids: depth < maxDepth ? kidEls.slice(0, 8).map((c) => describe(c, depth + 1, maxDepth)).filter(Boolean) : []
    };
  }

  function run() {
    const anchor = findAnchor();
    if (!anchor) {
      console.log('没找到锚点元素。请确认当前在答题对话页。');
      return;
    }
    // 向上找到 Page5 或页面根
    let root = anchor;
    for (let i = 0; i < 12 && root.parentElement; i++) {
      root = root.parentElement;
      if (root.id === 'Page5' || root.id === 'root') break;
    }
    const tree = describe(root, 0, 4);
    console.log('=== DOM 层级 ===');
    console.log(JSON.stringify(tree, null, 2));

    // 同时给出当前识别结果
    if (window.__CAH__ && window.__CAH__.detect) {
      console.log('=== 诊断 ===');
      console.log(JSON.stringify(window.__CAH__.detect.diagnose(), null, 2));
    } else {
      console.log('（__CAH__ 不在这个上下文里，请在扩展的隔离世界执行诊断，或直接用面板的「诊断」按钮）');
    }
    return tree;
  }

  return run();
})();
