/**
 * portability 收尾杀进程：netstat 解析（纯函数）+ 真起一个「wrapper → 服务」两层进程验证能杀干净。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

const pluginRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const { parseNetstatListeningPids, listeningPids, killTree } = await import(
	pathToFileURL(join(pluginRoot, "scripts/lib/port-pids.mjs")).href
);

const NETSTAT = `
活动连接

  协议  本地地址          外部地址        状态           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1180
  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       4242
  TCP    127.0.0.1:18080        0.0.0.0:0              LISTENING       5151
  TCP    127.0.0.1:8080         127.0.0.1:51234        ESTABLISHED     4242
  TCP    127.0.0.1:51234        127.0.0.1:8080         ESTABLISHED     7777
  TCP    [::]:8080              [::]:0                 LISTENING       4242
  TCP    [::1]:8080             [::]:0                 ABHÖREN         4343
  UDP    0.0.0.0:8080           *:*                                    9999
`;

test("netstat：只取目标端口上的监听行", () => {
	assert.deepEqual(parseNetstatListeningPids(NETSTAT, 8080).sort(), [4242, 4343]);
});

test("netstat：端口不做前缀匹配，也不把对端端口当本地端口", () => {
	assert.deepEqual(parseNetstatListeningPids(NETSTAT, 18080), [5151]);
	assert.deepEqual(parseNetstatListeningPids(NETSTAT, 51234), []);
	assert.deepEqual(parseNetstatListeningPids(NETSTAT, 80), []);
});

test("netstat：空输出 / 乱码不抛", () => {
	assert.deepEqual(parseNetstatListeningPids("", 8080), []);
	assert.deepEqual(parseNetstatListeningPids("garbage\nTCP x", 8080), []);
});

test("killTree 不会杀自己", () => {
	killTree(process.pid);
	assert.ok(true);
});

const probe = (port) =>
	new Promise((resolve) => {
		const socket = net.connect({ port, host: "127.0.0.1" });
		socket.once("connect", () => (socket.destroy(), resolve(true)));
		socket.once("error", () => resolve(false));
	});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("真实进程：wrapper fork 出的监听进程能被找到并杀掉", async () => {
	// wrapper 再 spawn 一个监听端口的孙进程，模拟 `dsh web` 的结构
	const grandchild = `require('net').createServer().listen(0,'127.0.0.1',function(){process.send(this.address().port)});setInterval(()=>{},1e6)`;
	const wrapper = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','ignore','ignore','ipc']});c.on('message',p=>process.send(p));setInterval(()=>{},1e6)`;
	const child = spawn(process.execPath, ["-e", wrapper], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
	try {
		const port = await new Promise((resolve, reject) => {
			child.once("message", resolve);
			child.once("exit", () => reject(new Error("wrapper 提前退出")));
			setTimeout(() => reject(new Error("等端口超时")), 15_000);
		});
		assert.ok(await probe(port), "孙进程应在监听");
		const pids = listeningPids(port);
		assert.ok(pids.length > 0, `应找到监听 ${port} 的进程`);
		assert.ok(!pids.includes(child.pid), "监听者是孙进程而不是 wrapper");
		// 与 portability cleanup 同序：先杀 wrapper 树，再按端口兜底
		if (process.platform === "win32") killTree(child.pid);
		child.kill("SIGKILL");
		for (const pid of listeningPids(port)) killTree(pid);
		let open = true;
		for (let i = 0; i < 20 && open; i++) {
			await sleep(150);
			open = await probe(port);
		}
		assert.equal(open, false, "端口应已释放");
		assert.deepEqual(listeningPids(port), []);
	} finally {
		child.kill("SIGKILL");
	}
});
