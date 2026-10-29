// 用真实的题目和真实的系统提示词，验证输出格式能被 background.js 的解析器吃下
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 用 vm 载入 defaults.js，拿到真实的默认提示词
const sandbox = { globalThis: {}, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/shared/defaults.js'), 'utf8'), sandbox);
const SYSTEM = sandbox.__CAH__.defaults.DEFAULT_SYSTEM_PROMPT;

const BASE = (process.env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.ANTHROPIC_AUTH_TOKEN || '';
const MODEL = process.env.ANTHROPIC_MODEL || '';

const QUESTIONS = [
  '第 1 题（单选）Java 中用于声明常量的关键字是？\nA. final\nB. static\nC. const\nD. public',
  '第 2 题（判断）在 Java 中，String 是不可变类型。',
  '第 3 题（多选）下列属于 Spring 核心特性的是？\nA. IOC\nB. AOP\nC. 事务管理\nD. 垃圾回收',
  '第 4 题（填空）JDK 中，负责把 Java 源码编译成字节码的命令是 ____。'
];

// 复制 background.js 里的解析逻辑，保证测的是同一套
function parseAnswer(text) {
  const raw = String(text || '').trim();
  const ansMatch = raw.match(/答案\s*[:：]\s*([\s\S]*?)(?:\n\s*解析\s*[:：]|$)/);
  const expMatch = raw.match(/解析\s*[:：]\s*([\s\S]*)$/);
  let answer = ansMatch ? ansMatch[1].trim() : '';
  if (!answer) {
    answer = raw.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
  }
  answer = answer.replace(/^["'“”「」]|["'“”「」]$/g, '').trim();
  return { answer, explanation: expMatch ? expMatch[1].trim() : '' };
}

for (const q of QUESTIONS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(BASE + '/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': TOKEN,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        temperature: 0.2,
        system: SYSTEM,
        messages: [{ role: 'user', content: '对方：' + q }]
      }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const data = await res.json();
    const content = (data.content || []).map((c) => c.text || '').join('');
    const { answer, explanation } = parseAnswer(content);
    console.log('---');
    console.log('题:', q.split('\n')[0].slice(0, 40));
    console.log('原始输出:', JSON.stringify(content.slice(0, 120)));
    console.log('解析答案:', JSON.stringify(answer));
    console.log('解析解析:', JSON.stringify(explanation.slice(0, 60)));
    console.log(answer ? 'RESULT: OK' : 'RESULT: PARSE-FAIL');
  } catch (e) {
    clearTimeout(timer);
    console.log('题:', q.slice(0, 30), 'ERR', e.name, e.message);
  }
}
