/** Explicit human choices only. An ambiguous ID or missing answer never approves. */
export function terminalControl(kind: 'pi' | 'claude', text: string, pending: Array<Record<string, any>>): Record<string, any> | string | undefined {
  const match = text.match(/^\/(pending|allow|deny|answer)(?:\s+(\S+))?(?:\s+([\s\S]+))?$/);
  if (!match) return;
  const [, action, id, answer] = match;
  const requests = kind === 'claude' ? pending.filter(p => p.request?.subtype === 'can_use_tool') : pending;
  const key = (p: Record<string, any>) => kind === 'claude' ? p.request_id : p.id;
  if (action === 'pending') return requests.length ? requests.map(p => JSON.stringify({id: key(p), ...(kind === 'claude' ? {tool: p.request.tool_name, input: p.request.input} : {method: p.method, title: p.title, options: p.options})})).join('\n') : 'No pending questions.';
  const request = id ? requests.find(p => key(p) === id) : requests.length === 1 ? requests[0] : undefined;
  if (!request) throw Error('Use /pending, then supply the exact request ID.');
  if (kind === 'pi') {
    const response: Record<string, any> = {type: 'extension_ui_response', id: request.id};
    if (action === 'deny') return {...response, cancelled: true};
    if (request.method === 'confirm') {
      if (action === 'allow') return {...response, confirmed: true};
      if (action === 'answer' && answer && /^(yes|no)$/i.test(answer)) return {...response, confirmed: /^yes$/i.test(answer)};
      throw Error('Reply /allow, /deny, or /answer ID yes|no.');
    }
    if (action !== 'answer' || answer === undefined) throw Error('Use /answer ID followed by the requested value.');
    if (request.method === 'select' && !request.options?.includes(answer)) throw Error('Choose one of the exact values shown by /pending.');
    return {...response, value: answer};
  }
  const response: Record<string, any> = {type: 'control_response', response: {subtype: 'success', request_id: request.request_id}};
  if (action === 'deny') return {...response, response: {...response.response, response: {behavior: 'deny', message: 'Denied by the user in Herdr'}}};
  let updatedInput = request.request.input;
  if (action === 'answer') {
    if (!answer) throw Error('Use /answer ID followed by a JSON object containing the answer fields.');
    const fields = JSON.parse(answer);
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw Error('The answer must be a JSON object.');
    updatedInput = {...updatedInput, ...fields};
  } else if (request.request.tool_name === 'AskUserQuestion') throw Error('Use /answer ID with the answers JSON, or reply in Paseo.');
  return {...response, response: {...response.response, response: {behavior: 'allow', updatedInput}}};
}
