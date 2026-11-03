/** Tool calls whose host-plane UI has no QQ equivalent; relay them to the chat. */
export function relayHostCards(ctx, chatId, content) {
    for (const block of content) {
        if (typeof block !== 'object' || block === null)
            continue;
        const call = block;
        if (call.type !== 'tool-call')
            continue;
        if (call.name === 'exit_plan_mode') {
            const text = renderPlanCard(call.arguments, ctx.log);
            if (text !== undefined) {
                ctx.sendToChat(chatId, text).catch((error) => {
                    ctx.log('warn', 'plan card relay failed: ' + String(error));
                });
            }
        }
        else if (call.name === 'ask_user_question') {
            const parsed = parseQuestionCall(call.arguments, typeof call.id === 'string' ? call.id : undefined, ctx.log);
            if (parsed === undefined)
                continue;
            if (ctx.onQuestionCall !== undefined && parsed.callId !== '') {
                try {
                    ctx.onQuestionCall(chatId, parsed);
                }
                catch (error) {
                    ctx.log('debug', 'question state update failed: ' + String(error));
                }
            }
            ctx.sendToChat(chatId, renderQuestionCard(parsed)).catch((error) => {
                ctx.log('warn', 'question card relay failed: ' + String(error));
            });
        }
    }
}
/** Render an exit_plan_mode tool-call's plan for QQ, or undefined when unusable. */
export function renderPlanCard(rawArguments, log) {
    if (typeof rawArguments !== 'string' || rawArguments === '')
        return undefined;
    try {
        const parsed = JSON.parse(rawArguments);
        if (typeof parsed.plan !== 'string' || parsed.plan.trim() === '')
            return undefined;
        return '【📋 计划书】请确认以下计划——可在 Web 卡片确认，或直接回复「确认/继续」供参考：\n' + parsed.plan.trim();
    }
    catch {
        log('debug', 'plan card parse failed');
        return undefined;
    }
}
/**
 * Parse an ask_user_question tool-call block into a RelayQuestionCall (T2-B2).
 * @param rawArguments - the block's raw JSON arguments.
 * @param callId - the block's provider-issued call id (missing → '' and the
 *   caller must not register the batch, since it can never be settled).
 * @param log - bridge log for parse failures.
 */
export function parseQuestionCall(rawArguments, callId, log) {
    if (typeof rawArguments !== 'string' || rawArguments === '')
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(rawArguments);
    }
    catch {
        log('debug', 'question card parse failed');
        return undefined;
    }
    if (!Array.isArray(parsed.questions) || parsed.questions.length === 0)
        return undefined;
    const questions = [];
    parsed.questions.forEach((entry, index) => {
        if (typeof entry !== 'object' || entry === null)
            return;
        const question = entry;
        if (typeof question.question !== 'string')
            return;
        const id = typeof question.id === 'string' && question.id !== '' ? question.id : 'q' + (index + 1);
        const header = typeof question.header === 'string' ? question.header : '';
        const options = Array.isArray(question.options)
            ? question.options
                .map((option) => (typeof option === 'object' && option !== null ? option.label : undefined))
                .filter((label) => typeof label === 'string')
            : [];
        questions.push({
            id,
            question: question.question,
            header,
            options,
            multiSelect: question.multi_select === true,
        });
    });
    if (questions.length === 0)
        return undefined;
    return { callId: callId ?? '', questions };
}
/** Display label for option i: a–z for the first 26 options, then a 1-based
 * number. question-answer.ts's optionLabel accepts both single letters and
 * numbers, so the mapping stays closed past z (two-letter labels like 'aa'
 * would NOT parse back — hence the numeric fallback). */
function optionLetter(i) {
    return i < 26 ? String.fromCharCode(97 + i) : String(i + 1);
}
/** Render a parsed ask_user_question call as the QQ option card (T2-B2 text).
 * The header line mirrors question-answer.ts's parse contract: pure numbered
 * selection is only unambiguous for single-question batches (parseQuestionAnswer
 * returns undefined when questions.length !== 1), so multi-question batches
 * steer the user to the whole-batch 答:/跳过 forms instead. T2-board: a
 * single question with NO options rejects pure numbering too (parseQuestionAnswer
 * returns undefined when options.length === 0), so its header guides the
 * 答:/跳过 forms instead of the numbered-selection mislead. */
export function renderQuestionCard(call) {
    const single = call.questions.length === 1;
    const lines = [!single
            ? '【❓ 提问】' + call.questions.length + ' 道题：回复『答:内容』整体回答（应用于全部题目），或回复『跳过』放弃；纯编号选择仅单题支持：'
            : single && call.questions[0].options.length === 0
                ? '【❓ 提问】本题没有候选项：回复「答:内容」自由作答，或回复『跳过』放弃：'
                : '【❓ 提问】回复编号或字母选择，多选用逗号，回复『跳过』放弃；自由回答用「答:内容」：'];
    call.questions.forEach((question, index) => {
        lines.push((index + 1) + '. ' + (question.header !== '' ? '[' + question.header + '] ' : '') + question.question);
        question.options.forEach((label, i) => {
            lines.push('   ' + optionLetter(i) + ') ' + label);
        });
        if (question.multiSelect)
            lines.push('   （可多选）');
    });
    return lines.join('\n');
}
