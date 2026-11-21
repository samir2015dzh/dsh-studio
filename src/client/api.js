/** Error carrying the route's JSON error message. */
var ApiError = class extends Error {
	constructor(message, extra) {
		super(message);
		this.name = "SkillManagerApiError";
		this.status = extra && extra.status;
		this.code = extra && extra.code;
		this.body = extra && extra.body;
	}
};
/** Parse a JSON response or throw an ApiError. */
async function readJson(response) {
	let body;
	try {
		body = await response.json();
	} catch {
		throw new ApiError("HTTP " + response.status + ": invalid JSON response");
	}
	if (!response.ok) {
		throw new ApiError(typeof body === "object" && body !== null && typeof body.error === "string" ? body.error : "HTTP " + response.status, {
			status: response.status,
			code: typeof body === "object" && body !== null && typeof body.code === "string" ? body.code : undefined,
			body
		});
	}
	return body;
}
/** Plain fetch helper with an error wrapper. */
async function request(path, init) {
	let response;
	try {
		response = await fetch(path, init);
	} catch (error) {
		throw new ApiError("网络请求失败：" + String(error instanceof Error ? error.message : error));
	}
	return readJson(response);
}
/** 只合并 JSON POST 装配；无 body 的提取请求仍走原 request。 */
function postJson(path, body) {
	return request(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body)
	});
}
/** The skill-manager panel API. */
var Api = class {
	async list() {
		return request("/api/dsh-studio/list");
	}
	async get(name) {
		return request("/api/dsh-studio/skill?name=" + encodeURIComponent(name));
	}
	async save(name, content, opts) {
		const body = { name, content };
		if (opts && opts.expectedMtime !== undefined) body.expectedMtime = opts.expectedMtime;
		if (opts && opts.overwrite === true) body.overwrite = true;
		return postJson("/api/dsh-studio/skill", body);
	}
	async setPolicy(name, patch) {
		return postJson("/api/dsh-studio/policy", Object.assign({ name }, patch));
	}
	/** 回收站：列表 / 删除到回收站 / 恢复 / 永久删除。 */
	async trashList() {
		return request("/api/dsh-studio/trash");
	}
	async trashSkill(name, cwd) {
		return postJson("/api/dsh-studio/trash", { name, cwd });
	}
	async restoreTrash(id, name) {
		return postJson("/api/dsh-studio/restore", { id, name });
	}
	async purgeTrash(id, name) {
		return postJson("/api/dsh-studio/purge", { id, name });
	}
	/** 配置快照：建 / 列 / 恢复 / 清理 / 导出导入。 */
	async snapshotList() {
		return request("/api/dsh-studio/snapshot");
	}
	async snapshotCreate(label) {
		return postJson("/api/dsh-studio/snapshot", { label });
	}
	async snapshotRestore(id, dryRun, pathMap) {
		return postJson("/api/dsh-studio/snapshot/restore", { id, dryRun, pathMap });
	}
	async snapshotPrune(keep) {
		return postJson("/api/dsh-studio/snapshot/prune", { keep });
	}
	async syncConfig(patch) {
		if (patch === undefined) return request("/api/dsh-studio/sync");
		return postJson("/api/dsh-studio/sync", patch);
	}
	async syncPush(snapshotId, channel) {
		return postJson("/api/dsh-studio/sync/push", { snapshotId, channel });
	}
	async syncPull(channel, label) {
		return postJson("/api/dsh-studio/sync/pull", { channel, label });
	}
	async snapshotSchedule(patch) {
		if (patch === undefined) return request("/api/dsh-studio/snapshot/schedule");
		return postJson("/api/dsh-studio/snapshot/schedule", patch);
	}
	async snapshotDelete(id) {
		return postJson("/api/dsh-studio/snapshot/delete", { id });
	}
	async skillImport(source) {
		return postJson("/api/dsh-studio/skill-import", { source });
	}
	async skillExport(name, path) {
		const body = { name };
		if (path) body.path = path;
		return postJson("/api/dsh-studio/skill-export", body);
	}
	async snapshotTransfer(payload) {
		return postJson("/api/dsh-studio/snapshot/transfer", payload);
	}
	async extractStatus() {
		return request("/api/dsh-studio/extract-status");
	}
	async extractConfig(patch) {
		return postJson("/api/dsh-studio/extract-config", patch);
	}
	async extractRun() {
		return request("/api/dsh-studio/extract-run", { method: "POST" });
	}
	async extractCandidates() {
		return request("/api/dsh-studio/extract-candidates");
	}
	async extractCandidate(id, patch) {
		return postJson("/api/dsh-studio/extract-candidate", Object.assign({ id }, patch));
	}
	async extractAccept(ids) {
		return postJson("/api/dsh-studio/extract-accept", { ids });
	}
	async extractRecent() {
		return request("/api/dsh-studio/extract-recent");
	}
	async extractReject(ids) {
		return postJson("/api/dsh-studio/extract-reject", { ids });
	}
	/** 新蒸馏队列与历史候选并存；不提供绕过评估门的接受接口。 */
	async distillStatus(id) {
		return request("/api/dsh-studio/distill/status" + (id ? "?id=" + encodeURIComponent(id) : ""));
	}
	async distillRun() {
		return postJson("/api/dsh-studio/distill/run", {});
	}
	async distillDecide(id, decision, reason) {
		return postJson("/api/dsh-studio/distill/decide", { id, decision, reason });
	}
	async distillSource(id) {
		return request("/api/dsh-studio/distill/source?id=" + encodeURIComponent(id));
	}
	/** MCP 按需加载：注册表、档位、空闲阈值。 */
	async mcpList() {
		return request("/api/dsh-studio/mcp");
	}
	/** ：注册表损坏闸——所有者确认后解闸（坏文件仍留档）。 */
	async mcpCorruptAck() {
		return postJson("/api/dsh-studio/mcp/registry-corrupt", { confirm: true });
	}
	async mcpUpsert(entry) {
		return postJson("/api/dsh-studio/mcp", entry);
	}
	async mcpRemove(name) {
		return request("/api/dsh-studio/mcp?name=" + encodeURIComponent(name), { method: "DELETE" });
	}
	async mcpReload(name) {
		return postJson("/api/dsh-studio/mcp/reload", { name });
	}
	async mcpPrefetch(name) {
		return postJson("/api/dsh-studio/mcp/prefetch", { name });
	}
	async mcpTools(name, mode, names) {
		return postJson("/api/dsh-studio/mcp/tools", { name, mode, names });
	}
	async mcpTakeover(name) {
		return postJson("/api/dsh-studio/mcp/takeover", { name });
	}
	async mcpSettings(patch) {
		return postJson("/api/dsh-studio/mcp/settings", patch);
	}
	/** 凭据明文只走这条 loopback 路由按需取，列表里永远是掩码。 */
	async mcpCredential(name, kind, key) {
		return postJson("/api/dsh-studio/mcp/credential", { name, kind, key });
	}
	/** 上游版本检查：会联网查 npm registry / git ls-remote，只在用户点按钮时调。 */
	async mcpUpdateCheck(name) {
		const query = typeof name === "string" && name !== "" ? "?name=" + encodeURIComponent(name) : "";
		return request("/api/dsh-studio/mcp/update-check" + query);
	}
};

export { Api };
