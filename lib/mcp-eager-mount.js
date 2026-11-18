/**
 * B4：eager MCP 工具的挂载器——「新的一组就绪后再替换」。
 *
 * 以前注册表一变就先把全部 mcp__* 工具注销、再逐台重连，慢 / 坏的 server 握手期间（最长 45 秒）
 * 模型手里一个 MCP 工具都没有。这里旧的一组留到新的一组建好；卸旧与注册新在同一个同步段里完成
 * （没有空档，也不会同名重复注册）。连着几次变更只认最后一次发起的那轮，早发起、晚完成的结果丢弃。
 * 构建失败时旧的一组保持不动。
 */

/**
 * @param {{
 *   build: () => Promise<Array<{name: string}>>,
 *   register: (tool: object) => () => void,
 *   onNames?: (names: Set<string>) => void,
 *   logger?: {info?: Function, warn?: Function} | null
 * }} deps
 */
export function createEagerMount(deps) {
	let gen = 0;
	let live = null;
	const names = new Set();
	const replace = (tools) => {
		const old = live;
		live = null;
		if (old !== null) for (const dispose of old) dispose();
		names.clear();
		if (tools !== null) {
			for (const tool of tools) names.add(tool.name);
			live = tools.map((tool) => deps.register(tool));
		}
		deps.onNames?.(names);
	};
	return {
		/** 发起一轮重建；返回这轮的 Promise（测试用），结果是否被采纳看 gen。 */
		mount() {
			const mine = (gen += 1);
			return Promise.resolve()
				.then(() => deps.build())
				.then((tools) => {
					if (mine !== gen) return false;
					replace(tools);
					if (tools.length > 0) deps.logger?.info?.("[dsh-studio] 已注册 " + tools.length + " 个 eager MCP 工具");
					return true;
				})
				.catch((error) => {
					deps.logger?.warn?.("[dsh-studio] eager MCP 挂载失败：" + String(error?.message ?? error));
					return false;
				});
		},
		/** 卸载全部，并作废在途的重建。 */
		dispose() {
			gen += 1;
			replace(null);
		},
		names
	};
}
