/**
 * 技能列表空状态：库空、正在读、筛选/搜索后为空、加载失败。
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const { listEmptyKind, listEmptyText } = await import(
	pathToFileURL(join(pluginRoot, "lib/panel-list-empty.js")).href
);

let failed = 0;
const assert = (cond, msg) => {
	if (!cond) {
		failed += 1;
		console.error("FAIL", msg);
	} else console.log("PASS", msg);
};

const base = {
	skills: [{ name: "a" }, { name: "b" }],
	err: "",
	query: "",
	sourceFilter: "all",
	activeFilter: "all",
	groupFilter: "all",
	visibleCount: 2,
};

assert(listEmptyKind(base) === null, "有可见技能时没有空状态");
assert(listEmptyKind({ ...base, skills: null, visibleCount: 0 }) === "loading", "尚未读到列表是正在读取");
assert(listEmptyText("loading") === "正在读取技能列表…", "读取中的文案");
assert(listEmptyKind({ ...base, skills: [], visibleCount: 0 }) === "empty", "库里没有任何技能");
assert(listEmptyText("empty") === "这里还没有技能。", "库空文案");
assert(
	listEmptyKind({ ...base, skills: [], err: "没法读取技能列表：网络中断", visibleCount: 0 }) === "load-error",
	"列表读失败且库空",
);
assert(
	listEmptyKind({ ...base, query: "zebraword", visibleCount: 0 }) === "filtered",
	"搜索无结果",
);
assert(
	listEmptyKind({ ...base, query: "", sourceFilter: "user", visibleCount: 0 }) === "filtered",
	"只开来源筛选、结果为 0 也是筛选空（不是空白）",
);
assert(
	listEmptyKind({ ...base, activeFilter: "off", visibleCount: 0 }) === "filtered",
	"只开启用筛选、结果为 0",
);
assert(
	listEmptyKind({ ...base, groupFilter: "内容创作", visibleCount: 0 }) === "filtered",
	"只开分类筛选、结果为 0",
);
assert(listEmptyText("filtered") === "没有符合条件的技能。", "筛选空文案");
assert(
	listEmptyKind({ ...base, query: "x", visibleCount: 1 }) === null,
	"筛选后仍有结果则不显示空状态",
);
assert(
	listEmptyKind({ ...base, skills: [], err: "失败", query: "foo", visibleCount: 0 }) === "filtered",
	"有搜索词时即使带错误也优先显示筛选空（错误会另处展示）",
);
assert(listEmptyText("load-error") === "" && listEmptyText(null) === "", "加载失败文案由调用方附上原因");

if (failed > 0) {
	console.error(`\n${failed} failed`);
	process.exit(1);
}
console.log("\nall passed");
