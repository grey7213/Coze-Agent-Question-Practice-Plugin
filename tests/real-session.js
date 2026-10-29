/* Bounded, redacted checks against the existing real Chrome/Coze session.
   node tests/real-session.js state|prepare|login|generate|send|pause|screenshot
   send is deliberately a separate, explicit command. */
const fs = require('fs');
const path = require('path');
const R = require('./real-flow');

async function evaluate(page, expression, contextId) {
  const result = await page.send('Runtime.evaluate', {
    expression, contextId, awaitPromise: true, returnByValue: true, timeout: 5000
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function contexts(page) {
  const result = await R.classifyContexts(page);
  const top = result.top.find(c => c.hasExt);
  const frame = result.frames.find(c => c.hasExt && c.url.includes('ui-builder-app/7689061576766685203'));
  if (!top || !frame) throw new Error('未找到真实页面的顶层和答题 iframe 扩展上下文');
  return { top: top.ctxId, frame: frame.ctxId };
}

async function readState(page, ctx) {
  const frame = await evaluate(page, `(() => {
    const c = __CAH__, t = c.__test__, e = t.engine, s = t.settings;
    const login = c.login.looksLikeLoginPage();
    const list = e.resolveList(), rows = e.readMessages(), target = e.pickTargetMessage(rows);
    const input = e.resolveInput(), send = e.resolveSend();
    return {
      build:c.BUILD, login, credentialsReady:!!(s.loginStudentId && s.loginName),
      autoLogin:s.autoLogin, loginAutoSubmit:s.loginAutoSubmit,
      requireConfirm:s.requireConfirm, autoAdvance:s.autoAdvance,
      running:e.running, ...e.snapshot(),
      list:c.util.cssPath(list), rows:rows.length,
      latest:target ? target.text : null,
      input:login ? null : c.fill.readBack(input),
      inputFound:!!input, sendFound:!!send,
      messages:login ? [] : rows.slice(-6).map(m => ({id:m.el.getAttribute('data-message-id'),text:m.text.slice(0,1600)})),
      fields:[...document.querySelectorAll('input,textarea')].map(n=>({id:n.id,length:n.value.length,disabled:n.disabled})),
      buttons:[...document.querySelectorAll('button')].filter(n=>c.util.isVisible(n)).map(n=>({text:n.innerText.trim().slice(0,50),disabled:n.disabled}))
    };
  })()`, ctx.frame);
  const top = await evaluate(page, `(() => {
    const p=__CAH__.__test__.panel;
    return {build:__CAH__.BUILD,bus:window.__cahBusDebug(),title:p.titleText.textContent,
      question:p.qEl.textContent,answer:p.aEl.textContent,error:p.errEl.textContent};
  })()`, ctx.top);
  return { checkedAt:new Date().toISOString(), frame, top };
}

async function clickPanel(page, ctx, property) {
  if (!['btnStart','btnStop','btnSend','btnGen'].includes(property)) throw new Error('不支持的面板动作');
  return evaluate(page, `(() => {
    const button=__CAH__.__test__.panel.${property};
    if (!button || button.disabled) throw new Error('面板按钮不可用');
    button.click(); return true;
  })()`, ctx.top);
}

async function poll(page, predicate, timeoutMs=60000) {
  const end=Date.now()+timeoutMs;
  let state;
  do {
    const ctx=await contexts(page);
    state=await readState(page,ctx);
    if(predicate(state)) return {ctx,state};
    if(state.frame.error && state.frame.state==='error') throw new Error(state.frame.error);
    await R.sleep(700);
  } while(Date.now()<end);
  throw new Error('等待真实页面状态超时: '+JSON.stringify({state:state?.frame.state,rows:state?.frame.rows}));
}

async function screenshot(page, ctx, name) {
  // Hide identity fields with reversible styles. Never alter their values.
  for(const id of [ctx.top,ctx.frame]) await evaluate(page, `(() => {
    if(document.getElementById('cah-proof-mask')) return;
    const s=document.createElement('style');s.id='cah-proof-mask';
    s.textContent='input[type=password],#Textarea1,#Textarea2,#loginStudentId,#loginName,#apiKey {visibility:hidden!important}';
    document.head.append(s);
  })()`, id);
  try { return await R.shot(page,name); }
  finally {
    for(const id of [ctx.top,ctx.frame]) await R.tryEval(page,"document.getElementById('cah-proof-mask')?.remove()",id);
  }
}

(async()=>{
  const action=process.argv[2]||'state';
  if(action==='--help' || action==='-h') {
    console.log('用法: node tests/real-session.js state|prepare|login|generate|send|pause|screenshot');
    console.log('连接现有 Coze 调试会话；生成只填不发，send 是单独的显式动作。');
    return;
  }
  if(!['state','prepare','login','generate','send','pause','screenshot'].includes(action)) throw new Error('未知动作');
  const page=await R.attach(R.loadSession().targetId);
  if(action!=='state') {
    await page.send('Page.bringToFront');
    await page.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  }
  let ctx=await contexts(page);
  let before=await readState(page,ctx);
  const expectedBuild=fs.readFileSync(path.join(R.ROOT,'src/shared/build.js'),'utf8')
    .match(/CAH\.BUILD\s*=\s*'([^']+)'/)?.[1];
  if(action!=='state' && (!expectedBuild || before.frame.build!==expectedBuild || before.top.build!==expectedBuild)) {
    throw new Error('页面扩展版本与源码不一致，请重新加载扩展并刷新 Coze 页面');
  }
  const proof={action,before};

  if(action==='prepare') {
    await evaluate(page, `(() => {
      const p=__CAH__.__test__.panel;
      for(const [field,value] of [['chkRequireConfirm',true],['chkAutoAdvance',false]]) {
        if(p[field].checked!==value) {p[field].checked=value;p[field].dispatchEvent(new Event('change'));}
      }
      return true;
    })()`,ctx.top);
    await poll(page,s=>s.frame.requireConfirm && !s.frame.autoAdvance,5000);
  }

  if(action==='login') {
    if(!before.frame.credentialsReady) throw new Error('扩展尚未配置学号和姓名');
    if(!before.frame.login) throw new Error('当前不在智能体登录页');
    const result=await evaluate(page, `__CAH__.login.attemptLogin(
      {...__CAH__.__test__.settings,autoLogin:true,loginAutoSubmit:false},{dryRun:true})`,ctx.frame);
    if(!result?.ok) throw new Error('智能体表单填写失败: '+(result?.reason||'未知错误'));
    await R.sleep(400);
    await evaluate(page, `(() => {
      const b=[...document.querySelectorAll('button')].find(n=>n.innerText.trim()==='登录');
      if(!b||b.disabled) throw new Error('智能体登录按钮不可用'); b.click(); return true;
    })()`,ctx.frame);
    const resultAfter=await poll(page,s=>!s.frame.login,20000);
    ctx=resultAfter.ctx;
  }

  if(action==='generate') {
    if(before.frame.login) throw new Error('请先进入真实答题页');
    if(!before.frame.requireConfirm || before.frame.autoAdvance) throw new Error('真实测试要求开启发送前确认并关闭自动进阶');
    if(!before.frame.inputFound || !before.frame.latest) throw new Error('未识别到真实题目或输入框');
    const recognized=await evaluate(page, `__CAH__.classify.looksLikeQuestion(__CAH__.__test__.engine.pickTargetMessage(__CAH__.__test__.engine.readMessages())?.text||'')`,ctx.frame);
    if(!recognized) throw new Error('最新消息不是题目，未调用模型');
    await clickPanel(page,ctx,'btnStart');
    const result=await poll(page,s=>s.frame.state==='ready' && !!s.frame.answer,75000);
    ctx=result.ctx;
    await R.sleep(1800);
    const ready=await readState(page,ctx);
    if(ready.frame.input.trim()!==ready.frame.answer.trim()) throw new Error('真实输入框内容与答案不一致');
    if(ready.frame.rounds!==before.frame.rounds || ready.frame.rows!==before.frame.rows) throw new Error('确认模式下出现非预期的发送或新消息');
    if(ready.top.question!==ready.frame.question || ready.top.answer!==ready.frame.answer) throw new Error('顶层面板未同步真实 iframe 状态');
    proof.checks=['真实题目识别','扩展后台调用模型','真实输入框回读一致','顶层面板同步','确认模式未自动发送'];
    proof.screenshot=await screenshot(page,ctx,'real-confirmed-fill.png');
    if(!proof.screenshot) throw new Error('真实填入已完成，但截图未成功');
    await clickPanel(page,ctx,'btnStop');
  }

  if(action==='send') {
    if(before.frame.login || !before.frame.answer) throw new Error('没有已生成的真实答案');
    if(!before.frame.requireConfirm || before.frame.autoAdvance) throw new Error('受控发送要求保留人工确认模式');
    if(!before.frame.running) {
      await clickPanel(page,ctx,'btnStart');
      const resumed=await poll(page,s=>['ready','advance_ready'].includes(s.frame.state),5000);
      ctx=resumed.ctx;
      if(resumed.state.frame.answer!==before.frame.answer || resumed.state.frame.rounds!==before.frame.rounds) {
        throw new Error('恢复确认状态时答案或轮数已变化，未发送');
      }
    }
    await clickPanel(page,ctx,'btnSend');
    const result=await poll(page,s=>s.frame.rounds===before.frame.rounds+1 && s.frame.input==='',12000);
    ctx=result.ctx;
    await clickPanel(page,ctx,'btnStart');
    await R.sleep(6000);
    const after=await readState(page,ctx);
    if(after.frame.rounds!==before.frame.rounds+1) throw new Error('发生重复发送');
    proof.checks=['显式面板发送一次','输入框清空','未重复发送'];
    proof.screenshot=await screenshot(page,ctx,'real-controlled-send.png');
  }

  if(action==='pause') await clickPanel(page,ctx,'btnStop');
  if(action==='screenshot') proof.screenshot=await screenshot(page,ctx,'real-session.png');
  proof.after=await readState(page,ctx);
  proof.ok=true;
  fs.mkdirSync(R.OUTPUT,{recursive:true});
  fs.writeFileSync(path.join(R.OUTPUT,'real-session-'+action+'.json'),R.redact(JSON.stringify(proof,null,2)));
  console.log({ok:true,action,checks:proof.checks,state:proof.after.frame.state,
    login:proof.after.frame.login,rows:proof.after.frame.rows,
    question:proof.after.frame.question,answer:proof.after.frame.answer,
    latest:proof.after.frame.latest,input:proof.after.frame.input,
    requireConfirm:proof.after.frame.requireConfirm,autoAdvance:proof.after.frame.autoAdvance,
    rounds:proof.after.frame.rounds,screenshot:proof.screenshot,
    evidence:path.join(R.OUTPUT,'real-session-'+action+'.json')});
})().catch(error=>{console.error('真实验证失败:',error.message);process.exitCode=1;})
  .finally(()=>{for(const ws of R.connections) ws.close();});
