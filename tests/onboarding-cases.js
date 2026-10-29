/* Runs inside Chrome against the observed SDK cold-start structure. */
(async () => {
  const {detect:D,util:U,classify:C,fill:F,Engine,defaults}=__CAH__;
  const cases=[];
  const check=(name,ok,detail)=>cases.push({name,ok:!!ok,detail:detail===undefined?undefined:structuredClone(detail)});
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async(read,ms=3500)=>{const end=Date.now()+ms;do{if(read())return true;await pause(60);}while(Date.now()<end);return false;};
  const fixture=__onboarding, input=document.querySelector('textarea');
  const welcome=document.querySelector('.chat-uikit-on-boarding__prologue').innerText;
  const list=D.findMessageList(), rows=D.getMessageRows(list);
  check('开场：无消息 ID 时定位实际 SDK 滚动区',list?.id==='onboarding-scroll',list?.id);
  check('开场：只读取一条完整欢迎语',rows.length===1&&U.textOf(rows[0])===welcome,rows.map(U.textOf));
  check('开场：消息不包含标题、页脚与导航按钮',rows.length>0&&rows.every(e=>!/^《|内容由AI|查看排行|返回上一页/.test(U.textOf(e))));
  check('开场：准备好答题识别为确认提示',C.isContinuePrompt(welcome,C.buildPatterns({})));
  check('开场：欢迎语的问号不算具体题目',!C.looksLikeQuestion(welcome));
  check('继续：只有问号的继续提示仍能识别',C.isContinuePrompt('是否继续下一题？',C.buildPatterns({})));
  check('继续：问句确认不调用答题模型',!C.looksLikeQuestion('是否继续下一题？'));
  check('题目：带选项的准备好问句仍是试题',C.looksLikeQuestion('【单选题】(2 分)\n程序输出“准备好答题了吗？”的语句是？\nA：print；B：input')&&!C.isContinuePrompt('【单选题】(2 分)\n程序输出“准备好答题了吗？”的语句是？\nA：print；B：input',C.buildPatterns({})));
  check('反馈：引用准备好问句不触发开场',!C.isContinuePrompt('你的答题结果是：正确\n本题得分：2\n准备好答题了吗？',C.buildPatterns({})));
  check('发送：空输入不能把麦克风或上传当发送',D.findSendButton(input)===null);
  await F.fill(input,'是');
  check('发送：填入后识别真正发送按钮',D.findSendButton(input)?.el.getAttribute('data-testid')==='bot-home-chart-send-button');
  input.value='';input.dispatchEvent(new InputEvent('input',{bubbles:true}));
  // Same-size icon controls, with no send button: never click upload/microphone.
  check('发送：清空后重新定位而非沿用旧按钮',D.findSendButton(input)===null);
  document.querySelector('#primary-action svg').setAttribute('class','icon-icon-coz_stop_circle');
  check('发送：响应期间的停止按钮不能当作发送',D.findSendButton(input)===null);
  input.dispatchEvent(new InputEvent('input',{bubbles:true}));
  const classification=D.diagnose().steps.find(s=>s.step==='分类');
  check('诊断：显示开场而不是返回上一页',classification?.isContinue===true&&classification.isQuestion===false&&classification.lastText.includes('准备好答题'));
  let modelCalls=0;
  const engine=new Engine({settings:defaults.withDefaults({requireConfirm:true,autoAdvance:false,stabilizeMs:180,actionDelayMs:20,maxRounds:5}),askAI:async()=>{modelCalls++;return{ok:true,answer:'C',explanation:'本地夹具答案'};}});
  engine.start();
  await until(()=>engine.state==='advance_ready');
  check('闭环：开场准备是并等待确认',engine.state==='advance_ready'&&engine.answer==='是',{state:engine.state,answer:engine.answer});
  check('闭环：开场不调用模型、不自动发送',modelCalls===0&&fixture.sent.length===0);
  if(engine.state==='advance_ready'){
    await Promise.all([engine.sendCurrent(),engine.sendCurrent()]);
    await until(()=>engine.state==='ready'&&engine.answer==='C');
  }
  check('闭环：确认开场只发送一次',fixture.sent.length===1&&fixture.sent[0]==='是',fixture.sent);
  check('闭环：第一题识别、模型生成及真实输入回读',modelCalls===1&&engine.state==='ready'&&input.value==='C');
  check('闭环：保留欢迎语时只读取有 ID 的新消息',D.getMessageRows(D.findMessageList()).every(e=>e.hasAttribute('data-message-id')));
  if(engine.state==='ready'){
    await Promise.all([engine.sendCurrent(),engine.sendCurrent()]);
    await until(()=>engine.state==='advance_ready');
  }
  check('闭环：答案提交一次且输入清空',fixture.sent.length===2&&fixture.sent[1]==='C'&&input.value==='');
  check('闭环：判分后问句继续准备是',engine.state==='advance_ready'&&engine.answer==='是'&&modelCalls===1);
  check('闭环：确认模式不会自动继续',fixture.sent.length===2&&engine.rounds===2);
  if(engine.state==='advance_ready'&&fixture.sent.length===2){await engine.sendCurrent();await pause(1800);}
  check('闭环：继续发送、结束后不回扫欢迎语',fixture.sent.join(',')==='是,C,是'&&modelCalls===1&&engine.rounds===3);
  check('闭环：整个过程没有误点上传、麦克风或导航',fixture.unwanted.length===0,fixture.unwanted);
  engine.stop();
  // Live SDK user bubbles include a display name outside the message body. A
  // delayed server response must never cause another LLM call on our own answer.
  fixture.holdReply=true;
  const scroll=document.querySelector('#onboarding-scroll');
  scroll.replaceChildren();
  fixture.append('【单选题】(2 分)：哪个变量定义合法？\nA：int a = 12;\nB：boolean b = 1;');
  let selfCalls=0;
  const ownAnswer='A：int a = 12;';
  const delayed=new Engine({settings:defaults.withDefaults({requireConfirm:true,stabilizeMs:180}),askAI:async()=>{selfCalls++;return{ok:true,answer:ownAnswer};}});
  delayed.start();await until(()=>delayed.state==='ready');
  await delayed.sendCurrent();await pause(2100);
  check('本人消息：慢回复时不再次调用模型',selfCalls===1,selfCalls);
  check('本人消息：发送后保持等待回复',delayed.state==='waiting',delayed.state);
  const ownRow=D.getMessageRows(D.findMessageList()).at(-1);
  check('本人消息：读取正文时不混入显示名',delayed.readMessages().at(-1)?.text===ownAnswer);
  check('本人消息：真实 SDK 角色标记可用',D.messageRole?.(ownRow)==='user');
  delayed.stop();
  let restartedCalls=0;
  const restarted=new Engine({settings:defaults.withDefaults({requireConfirm:true,stabilizeMs:180}),askAI:async()=>{restartedCalls++;return{ok:true,answer:'B'};}});
  restarted.start();await pause(1800);restarted.stop();
  check('本人消息：刷新后无发送历史仍不会回答自己',restartedCalls===0,restartedCalls);
  const failedIcon=document.createElement('span');failedIcon.className='icon-fail--fixture';ownRow.append(failedIcon);
  restarted.start();await until(()=>restarted.state==='error',2200);restarted.stop();
  check('发送失败：显示原气泡重试提示且不再次调用模型',/重新发送/.test(restarted.lastError)&&restartedCalls===0);
  scroll.replaceChildren();fixture.append('【判断题】(2 分)：Java int 占 4 字节。');
  fixture.append('准备好答题了吗？','user');
  check('本人消息：含开场问句也不能触发回复是',restarted.pickTargetMessage(restarted.readMessages())===null);
  scroll.lastElementChild.remove();fixture.append('内容由AI生成，仅供参考。','user');
  check('本人消息：噪音文字仍阻断旧题回扫',restarted.pickTargetMessage(restarted.readMessages())===null);
  const assistant=fixture.append(ownAnswer);
  check('对方消息：复述相同答案时 DOM 角色优先',!delayed.isOwnMessage(ownAnswer,assistant));
  // The generic fallback must not reintroduce Page5 when stable SDK markers vanish.
  document.querySelectorAll('[data-testid],[data-scroll-element],[data-message-id]').forEach(el=>{el.removeAttribute('data-testid');el.removeAttribute('data-scroll-element');el.removeAttribute('data-message-id');});
  const fallback=D.findMessageList();
  check('兜底：标记缺失时不把 Page5 或含编辑器外壳当列表',!fallback||(!fallback.querySelector('textarea')&&fallback.id!=='Page5'),fallback?.id);
  return cases;
})()
