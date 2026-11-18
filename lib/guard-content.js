/**
 * 写前守门（WO-BORROW-2）。
 *
 * 设计借用 hermes-agent（MIT）skills guard：内容命中危险模式就不直投，转候选队列等人看。
 * 只借设计，未移植其代码（仓库不在本机）。这里是一组启发式，不是安全边界：
 * 只拦明显的凭据泄露、无条件删除、外发执行三类，普通内容照常直落。
 */

/** 三类拦截模式。id 会写进候选的 guard.hits，面板据此标注原因。 */
export const CONTENT_GUARDS = [
	{
		id: "credential",
		label: "疑似凭据",
		// C4：补 sk-proj- / sk-ant- / sk-svcacct- / sk-admin-（带短横的新式 key）、github_pat_（细粒度 PAT）、ghu_/ghs_/ghr_
		re: /(sk-[A-Za-z0-9]{16,}|sk-(?:proj|ant(?:-api\d{2}|-admin\d{2})?|svcacct|admin)-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(api[_-]?key|apikey|password|passwd|secret|access[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{16,})/i
	},
	{
		id: "destructive",
		label: "无条件删除命令",
		// C4：旗标顺序与写法不限（-rf / -fr / -r -f / --recursive --force / --no-preserve-root），目标含 `/*`
		re: /(\brm\s+(?=(?:--?[a-z-]+\s+)*(?:-[a-z]*r|--recursive))(?=(?:--?[a-z-]+\s+)*(?:-[a-z]*f|--force))(?:--?[a-z-]+\s+)+["'`]?(?:\/\*?|~\/?\*?)["'`]?(?=\s|$|[;&|)])|rm\s+-rf\s+\*|del\s+\/[fsq]\s+[A-Za-z]:\\|Remove-Item\s+[^|\n]{0,200}?-Recurse[^|\n]{0,200}?-Force\s+[A-Za-z]:\\|mkfs\.[a-z0-9]+\s|format\s+[A-Za-z]:)/i
	},
	{
		id: "exfil",
		label: "外发下载即执行",
		// C4：管道后带 sudo（`| sudo bash`、`| sudo -E sh`）；PowerShell 的 `irm … | iex`、`iwr … | iex`
		re: /((?:curl|wget)\s+[^|\n]{0,300}\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:ba|z|fi|da)?sh\b|(?:irm|iwr|Invoke-RestMethod|Invoke-WebRequest)\b[^|\n]{0,300}\|\s*(?:iex|Invoke-Expression)\b|Invoke-Expression|iex\s*\(\s*(?:New-Object\s+Net\.WebClient|Invoke-WebRequest|iwr\b)|powershell(?:\.exe)?\s+-(?:enc|encodedcommand)\s+[A-Za-z0-9+/=]{20,}|eval\s*\(\s*(?:atob|Buffer\.from)\s*\()/i
	}
];

/**
 * 检查一段待落库的内容。
 * @param {string} text 候选的 name + description + body（合并路径传合并后的 body）
 * @returns {{ok:boolean, hits:{id:string,label:string}[]}}
 */
export function guardContent(text) {
	const body = typeof text === "string" ? text : "";
	if (body === "") return { ok: true, hits: [] };
	const hits = [];
	for (const guard of CONTENT_GUARDS) {
		if (guard.re.test(body)) hits.push({ id: guard.id, label: guard.label });
	}
	return { ok: hits.length === 0, hits };
}

/** 拼一个候选的待检文本（与写盘内容一致）。 */
export function guardTextOf(candidate) {
	if (candidate === null || typeof candidate !== "object") return "";
	return String(candidate.name ?? "") + "\n" + String(candidate.description ?? "") + "\n" + String(candidate.body ?? "");
}
