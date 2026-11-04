// dsh-plugin-scoped-instructions -- 主/子 agent 分离注入工作区指令
//
// 背景：
//   `dsh-agent-instructions` 把 $DSH_HOME/AGENTS.md + 项目 AGENTS.md 作为一条
//   「持久基线消息」注入每个 agent —— 主 agent 和子 agent 收到【完全相同】的内容。
//   但全局准则里 `<!-- scope:main -->` 标记的段落（计费时段、派活方法）子 agent 用不上，
//   白白占用它本就紧张的上下文预算。
//
// 做法：
//   在同一条 `agent/pre-step` 钩子链的外层再包一层 —— 等官方插件把基线消息装好后，
//   判断当前 agent 是不是子 agent；是的话，把基线文本里 scope:main 段落剔除。
//   主 agent 完全不受影响（原样返回 decision）。
//
// 判别依据（实测）：
//   agent.session.header.origin === 'subagent'        ← 明确标识
//   agent.session.header.delegationDepth > 0          ← 委派深度（实测子会话 = 1）
//
// 容错：
//   任何异常都原样返回 decision —— 绝不阻断对话、绝不让 DSH 起不来。

export const name = 'scoped-instructions';
export const inject = [];

const RE_OPEN_MAIN = /<!--\s*scope:main\s*-->/;
const RE_CLOSE_MAIN = /<!--\s*\/scope:main\s*-->/;
const RE_SCOPE_ALL = /<!--\s*\/?scope:all\s*-->/;
const RE_SYNC = /<!--\s*sync:[\w-]+[^>]*-->/;

/** 剔除 scope:main 段落（含成对标记本身），并去掉 scope:all 标记与 sync 注释 */
function stripMainScope(text) {
    const lines = text.split('\n');
    const out = [];
    let depth = 0;
    let dropped = 0;

    for (const line of lines) {
        if (RE_OPEN_MAIN.test(line)) { depth++; dropped++; continue; }
        if (RE_CLOSE_MAIN.test(line)) { if (depth > 0) depth--; continue; }
        if (depth > 0) { continue; }
        if (RE_SCOPE_ALL.test(line)) continue;
        if (RE_SYNC.test(line)) continue;
        out.push(line);
    }

    // 压缩连续空行 + 去掉开头/结尾多余的分隔线与空白
    const cleaned = [];
    let prevBlank = false;
    for (const line of out) {
        const blank = line.trim() === '';
        if (blank && prevBlank) continue;
        cleaned.push(line);
        prevBlank = blank;
    }
    while (cleaned.length > 0) {
        const t = cleaned[cleaned.length - 1].trim();
        if (t === '' || t === '---') cleaned.pop();
        else break;
    }

    return { text: cleaned.join('\n'), dropped };
}

/** 会不会真的改到东西？先探一下，避免无谓的对象重建 */
function needsStrip(text) {
    return RE_OPEN_MAIN.test(text) || RE_SCOPE_ALL.test(text) || RE_SYNC.test(text);
}

export function apply(ctx) {
    // 只做日志，不做 I/O 副作用（apply 阶段必须干净）
    const log = (msg) => {
        try { ctx.logger?.info?.('[scoped-instructions] ' + msg); } catch (e) { /* 静默 */ }
    };

    try {
        ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
            const decision = await next();

            try {
                // ── 判别：是不是子 agent ──
                const header = agent?.session?.header;
                const isSub = header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0;
                if (!isSub) return decision;

                if (!Array.isArray(decision?.messages)) return decision;

                // ── 找基线消息并过滤 ──
                let changed = false;
                let totalDropped = 0;

                const out = decision.messages.map((m) => {
                    if (m?.source?.kind !== 'agent-instructions') return m;
                    if (!Array.isArray(m.content)) return m;

                    let msgChanged = false;
                    const parts = m.content.map((part) => {
                        if (part?.type !== 'text' || typeof part.text !== 'string') return part;
                        if (!needsStrip(part.text)) return part;
                        const r = stripMainScope(part.text);
                        if (r.text === part.text) return part;
                        msgChanged = true;
                        totalDropped += r.dropped;
                        return { ...part, text: r.text };
                    });

                    if (!msgChanged) return m;
                    changed = true;
                    return { ...m, content: parts };
                });

                if (!changed) return decision;

                log('子 agent (depth=' + (header?.delegationDepth ?? '?') +
                    ') 指令已精简：剔除 ' + totalDropped + ' 个 scope:main 段');
                return { ...decision, messages: out };
            } catch (e) {
                // 出错绝不阻断
                log('过滤失败（已忽略）: ' + (e && e.message));
                return decision;
            }
        });
    } catch (e) {
        log('注册钩子失败: ' + (e && e.message));
    }
}

// 供本地测试使用
export { stripMainScope, needsStrip };
