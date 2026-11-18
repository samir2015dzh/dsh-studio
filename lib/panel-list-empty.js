/**
 * 技能列表的空状态。
 *
 * 以前只在搜索框有字时才提示「没有找到」；只开了来源 / 启用 / 分类筛选、
 * 结果为 0 时，列表会变成一块空白。这里按「库空 / 正在读 / 筛选后为空」分开。
 *
 * @param {{
 *   skills: Array<unknown> | null,
 *   err?: string,
 *   query?: string,
 *   sourceFilter?: string,
 *   activeFilter?: string,
 *   groupFilter?: string,
 *   visibleCount: number,
 * }} state
 * @returns {"loading" | "empty" | "filtered" | "load-error" | null}
 */
export function listEmptyKind(state) {
	const skills = state?.skills;
	const err = String(state?.err ?? "").trim();
	const query = String(state?.query ?? "").trim();
	const sourceFilter = state?.sourceFilter || "all";
	const activeFilter = state?.activeFilter || "all";
	const groupFilter = state?.groupFilter || "all";
	const visibleCount = Number(state?.visibleCount ?? 0);
	const loading = skills === null;
	const emptyLib = Array.isArray(skills) && skills.length === 0;
	const filtered =
		query !== "" || sourceFilter !== "all" || activeFilter !== "all" || groupFilter !== "all";

	if (err !== "" && emptyLib && !filtered) return "load-error";
	if (loading && !filtered) return "loading";
	if (emptyLib && err === "" && !filtered) return "empty";
	if (visibleCount === 0 && filtered) return "filtered";
	return null;
}

/** @param {ReturnType<typeof listEmptyKind>} kind */
export function listEmptyText(kind) {
	if (kind === "loading") return "正在读取技能列表…";
	if (kind === "empty") return "这里还没有技能。";
	if (kind === "filtered") return "没有符合条件的技能。";
	return "";
}
