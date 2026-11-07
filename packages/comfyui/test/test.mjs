// 契约测试（不需要 ComfyUI 服务）+ 可选真实调用（COMFYUI_TEST=1 且 ComfyUI 在跑）
import assert from 'node:assert';
import fs from 'node:fs';

const mod = await import(new URL('../lib/index.js', import.meta.url));

const regs = [];
const ctx = {
  tools: { register: (d) => { regs.push(d); return () => {}; } },
  get: () => undefined,
  logger: { info() {}, error() {} },
  effect: (f) => f(),
};

mod.apply(ctx);
let pass = 0;
function ok(name, fn) { fn(); pass++; console.log('PASS', name); }

ok('注册三个工具', () => assert.equal(regs.length, 3));
ok('名字正确', () => assert.deepEqual(regs.map((d) => d.name).sort(), ['comfyui_list', 'comfyui_params', 'comfyui_run']));

for (const d of regs) {
  if (!d.output || typeof d.output.render !== 'function') throw new Error(d.name + ' 缺 output.render');
  if (d.output.schema.type !== 'object') throw new Error(d.name + ' schema 根不是 object');
  const findArr = (n, p = '') => !n || typeof n !== 'object' ? null
    : Array.isArray(n.type) ? p + '.type'
    : Object.keys(n).map((k) => findArr(n[k], p + '.' + k)).find(Boolean) || null;
  if (findArr(d.output.schema)) throw new Error(d.name + ' schema 有类型数组');
  if (!d.parameters || d.parameters.type !== 'object') throw new Error(d.name + ' 缺 parameters');
}
pass += 2;
console.log('PASS output 契约 ×2');

const list = regs.find((d) => d.name === 'comfyui_list');
const run = regs.find((d) => d.name === 'comfyui_run');
const params = regs.find((d) => d.name === 'comfyui_params');

// 参数校验：不需要 ComfyUI 服务
await assert.rejects(() => run.execute({}), /workflow 必填/);
await assert.rejects(() => run.execute({ workflow: 'x.json', bad: 1 }), /未知参数/);
console.log('PASS 参数校验 ×2');
pass += 2;

const LIVE = process.env.COMFYUI_TEST === '1';
if (!LIVE) {
  console.log('SKIP 真实调用（设 COMFYUI_TEST=1 且 ComfyUI 在跑时执行）');
} else {
  // 真实调用：list
  const lr = await list.execute({});
  assert.ok(lr.text.includes('工作流目录'), 'list 无目录行');
  console.log('PASS comfyui_list 真实调用');
  pass++;

  // 参数清单（用第一个工作流）
  const files = fs.readdirSync(process.env.COMFYUI_WORKFLOWS || '').filter((f) => f.endsWith('.json'));
  if (files.length > 0) {
    const pr = await params.execute({ workflow: files[0] });
    assert.ok(pr.text.length > 0, 'params 输出为空');
    console.log('PASS comfyui_params 参数清单');
    pass++;
  } else {
    console.log('SKIP 工作流目录为空');
  }

  // async：mock jobs 验证提交 → 完成链
  const wf = files[0];
  if (wf) {
    const started = [];
    let outcomePromise = null;
    const mockJobs = {
      readAt: () => undefined,
      start: (def) => { started.push(def); const h = def.run(); outcomePromise = h.done; assert.equal(typeof h.cancel, 'function', 'run 必须返回 {cancel,done}'); return 'job-test-1'; },
    };
    const ctx2 = { ...ctx, get: (n) => (n === 'jobs' ? mockJobs : undefined), agent: { id: 'sess-test' } };
    mod.apply(ctx2);
    const a = await run.execute({ workflow: wf, mode: 'async', timeoutSec: 180 }, { agent: { id: 'sess-test' } });
    assert.ok(/已提交到后台/.test(a.text), 'async 回执不对: ' + a.text);
    assert.ok(/job-test-1/.test(a.text), 'async 回执缺 jobId');
    assert.equal(started.length, 1);
    console.log('PASS async 提交回执 + job 注册');
    pass++;
  }
}

console.log('TOTAL PASS', pass);
process.exit(0);
