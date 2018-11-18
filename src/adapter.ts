import { ChildProcess, fork } from 'child_process';
import * as fs from 'fs-extra';
import { IMinimatch, Minimatch } from 'minimatch';
import * as path from 'path';
import { parse as parseStackTrace } from 'stack-trace';
import * as stream from 'stream';
import * as vscode from 'vscode';
import {
	TestAdapter,
	TestDecoration,
	TestEvent,
	TestInfo,
	TestLoadFinishedEvent,
	TestLoadStartedEvent,
	TestRunFinishedEvent,
	TestRunStartedEvent,
	TestSuiteEvent,
	TestSuiteInfo,
} from 'vscode-test-adapter-api';
import { detectNodePath, Log } from 'vscode-test-adapter-util';

interface IDisposable {
	dispose(): void;
}

export class JasmineAdapter implements TestAdapter, IDisposable {

	private disposables: IDisposable[] = [];

	private readonly testsEmitter = new vscode.EventEmitter<TestLoadStartedEvent | TestLoadFinishedEvent>();
	private readonly testStatesEmitter = new vscode.EventEmitter<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent>();
	private readonly autorunEmitter = new vscode.EventEmitter<void>();

	private config?: LoadedConfig;
	private nodesById = new Map<string, TestSuiteInfo | TestInfo>();

	private runningTestProcess: ChildProcess | undefined;

	get tests(): vscode.Event<TestLoadStartedEvent | TestLoadFinishedEvent> {
		return this.testsEmitter.event;
	}

	get testStates(): vscode.Event<TestRunStartedEvent | TestRunFinishedEvent | TestSuiteEvent | TestEvent> {
		return this.testStatesEmitter.event;
	}

	get autorun(): vscode.Event<void> {
		return this.autorunEmitter.event;
	}

	constructor(
		public readonly workspaceFolder: vscode.WorkspaceFolder,
		public readonly channel: vscode.OutputChannel,
		private readonly log: Log
	) {

		this.disposables.push(this.testsEmitter);
		this.disposables.push(this.testStatesEmitter);
		this.disposables.push(this.autorunEmitter);

		this.disposables.push(vscode.workspace.onDidChangeConfiguration(configChange => {

			this.log.info('Configuration changed');

			if (configChange.affectsConfiguration('jasmineExplorer.config', this.workspaceFolder.uri) ||
				configChange.affectsConfiguration('jasmineExplorer.env', this.workspaceFolder.uri) ||
				configChange.affectsConfiguration('jasmineExplorer.nodePath', this.workspaceFolder.uri)) {

				this.log.info('Sending reload event');
				this.config = undefined;
				this.load();
			}
		}));

		this.disposables.push(vscode.workspace.onDidSaveTextDocument(document => {
			if (!this.config) return;

			const filename = document.uri.fsPath;
			if (this.log.enabled) this.log.info(`${filename} was saved - checking if this affects ${this.workspaceFolder.uri.fsPath}`);

			if (filename === this.config.configFilePath) {
				this.log.info('Sending reload event');
				this.config = undefined;
				this.load();
				return;
			}

			for (const glob of this.config.testFileGlobs) {
				if (glob.match(filename)) {
					if (this.log.enabled) this.log.info(`Sending reload event because ${filename} is a test file`);
					this.load();
					return;
				}
			}

			if (filename.startsWith(this.workspaceFolder.uri.fsPath)) {
				this.log.info('Sending autorun event');
				this.autorunEmitter.fire();
			}
		}));
	}

	async load(): Promise<void> {

		this.testsEmitter.fire(<TestLoadStartedEvent>{ type: 'started' });

		if (!this.config) {
			this.config = await this.loadConfig();
		}
		const config = this.config;
		if (!config) {
			this.testsEmitter.fire(<TestLoadFinishedEvent>{ type: 'finished', suite: undefined });
			return;
		}

		if (this.log.enabled) this.log.info(`Loading test files of ${this.workspaceFolder.uri.fsPath}`);

		const rootSuite: TestSuiteInfo = {
			type: 'suite',
			id: 'root',
			label: 'Jasmine',
			children: []
		}

		const suites: { [id: string]: TestSuiteInfo } = {};

		await new Promise<JasmineTestSuiteInfo | undefined>(resolve => {
			const args = [config.configFilePath, JSON.stringify(this.log.enabled)];
			const childProcess = fork(
				require.resolve('./worker/loadTests.js'),
				args,
				{
					cwd: this.workspaceFolder.uri.fsPath,
					env: config.env,
					execPath: config.nodePath,
					execArgv: config.nodeArgv,
					stdio: ['pipe', 'pipe', 'pipe', 'ipc']
				}
			);

			this.pipeProcess(childProcess);

			// The loader emits one suite per file, in order of running
			// When running in random order, the same file may have multiple suites emitted
			// This way the only thing we need to do is just to replace the name
			// With a shorter one
			childProcess.on('message', (message: string | JasmineTestSuiteInfo) => {

				if (typeof message === 'string') {

					this.log.info(`Worker: ${message}`);

				} else {

					if (this.log.enabled) this.log.info(`Received tests for ${message.file} from worker`);
					message.label = message.file!.replace(config.specDir, '');
					const file = message.file!;
					if (suites[file]) {
						suites[file].children = suites[file].children.concat(message.children);
					} else {
						suites[file] = message;
					}
				}
			});

			childProcess.on('exit', (exitVal) => {
				this.log.info('Worker finished');
				resolve();
			});
		});

		function sort(suite: (TestInfo | TestSuiteInfo)) {
			const s = suite as TestSuiteInfo;
			if (s.children) {
				s.children = s.children.sort((a, b) => {
					return a.line! - b.line!;
				});
				s.children.forEach((suite) => sort(suite));
			}
			return s;
		}

		// Sort the suites by their filenames
		Object.keys(suites).sort((a, b) => {
			return a.toLocaleLowerCase() < b.toLocaleLowerCase() ? -1 : 1;
		}).forEach((file) => {
			rootSuite.children.push(sort(suites[file]));
		});

		this.nodesById.clear();
		this.collectNodesById(rootSuite);

		if (rootSuite.children.length > 0) {
			this.testsEmitter.fire(<TestLoadFinishedEvent>{ type: 'finished', suite: rootSuite });
		} else {
			this.testsEmitter.fire(<TestLoadFinishedEvent>{ type: 'finished', suite: undefined });
		}
	}

	async run(testsToRun: string[], execArgv: string[] = []): Promise<void> {

		const config = this.config;
		if (!config) return;

		if (this.log.enabled) this.log.info(`Running test(s) ${JSON.stringify(testsToRun)} of ${this.workspaceFolder.uri.fsPath}`);

		this.testStatesEmitter.fire(<TestRunStartedEvent>{ type: 'started', tests: testsToRun });

		const testfiles = new Map<string, string>();
		for (const suiteOrTestId of testsToRun) {
			const node = this.nodesById.get(suiteOrTestId);
			if (node) {
				this.collectTestfiles(node, testfiles);
			}
		}

		const tests: string[] = [];
		for (const test of testfiles.keys()) {
			tests.push(test);
		}

		const args = [config.configFilePath, JSON.stringify(this.log.enabled)];
		if (tests) {
			args.push(JSON.stringify(tests));
		}

		return new Promise<void>((resolve) => {
			this.runningTestProcess = fork(
				require.resolve('./worker/runTests.js'),
				args,
				{
					cwd: this.workspaceFolder.uri.fsPath,
					env: config.env,
					execPath: config.nodePath,
					execArgv: config.nodeArgv,
					stdio: ['pipe', 'pipe', 'pipe', 'ipc']
				}
			);

			this.pipeProcess(this.runningTestProcess);

			this.runningTestProcess.on('message', (message: string | JasmineTestEvent) => {

				if (typeof message === 'string') {

					this.log.info(`Worker: ${message}`);

				} else {

					if (this.log.enabled) this.log.info(`Received ${JSON.stringify(message)}`);

					if (message.failures) {
						message.decorations = this.createDecorations(message, testfiles);
						delete message.failures;
					}

					this.testStatesEmitter.fire(message);
				}
			});

			this.runningTestProcess.on('exit', () => {
				this.log.info('Worker finished');
				this.runningTestProcess = undefined;
				this.testStatesEmitter.fire(<TestRunFinishedEvent>{ type: 'finished' });
				resolve();
			});
		});
	}

	async debug(testsToRun: string[]): Promise<void> {
		if (!this.config || (testsToRun.length === 0)) {
			return;
		}

		if (this.log.enabled) this.log.info(`Debugging test(s) ${JSON.stringify(testsToRun)} of ${this.workspaceFolder.uri.fsPath}`);

		let currentSession: vscode.DebugSession | undefined;
		// Add a breakpoint on the 1st line of the debugger
		if (this.config.breakOnFirstLine) {
			const node = this.nodesById.get(testsToRun[0]);
			if (node && node.file && node.line) {
				const fileURI = vscode.Uri.file(node.file);
				const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(fileURI, new vscode.Position(node.line + 1, 0)));
				vscode.debug.addBreakpoints([breakpoint]);
				const subscription = vscode.debug.onDidTerminateDebugSession((session) => {
					if (currentSession != session) { return; }
					vscode.debug.removeBreakpoints([breakpoint]);
					subscription.dispose();
				});
			}
		}

		const promise = this.run(testsToRun, [`--inspect-brk=${this.config.debuggerPort}`]);
		if (!promise || !this.runningTestProcess) {
			this.log.error('Starting the worker failed');
			return;
		}

		this.log.info('Starting the debug session');
		await vscode.debug.startDebugging(this.workspaceFolder, {
			name: 'Debug Jasmine Tests',
			type: 'node',
			request: 'attach',
			port: this.config.debuggerPort,
			protocol: 'inspector',
			timeout: 30000,
			stopOnEntry: false,
		});

		currentSession = vscode.debug.activeDebugSession;
		if (!currentSession) {
			this.log.error('No active debug session - aborting');
			this.cancel();
			return;
		}

		// Kill the process to ensure we're good once the de
		const subscription = vscode.debug.onDidTerminateDebugSession((session) => {
			if (currentSession != session) { return; }
			this.log.info('Debug session ended');
			this.cancel(); // just ot be sure
			subscription.dispose();
		});

		return promise;
	}

	cancel(): void {
		if (this.runningTestProcess) {
			this.log.info('Killing running test process');
			this.runningTestProcess.kill();
		}
	}

	dispose(): void {
		this.cancel();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables = [];
		this.nodesById.clear();
	}

	private pipeProcess(process: ChildProcess) {
		const customStream = new stream.Writable();
		customStream._write = (data, encoding, callback) => {
			this.channel.append(data.toString());
			callback();
		};
		process.stderr.pipe(customStream);
		process.stdout.pipe(customStream);
	}

	private async loadConfig(): Promise<LoadedConfig | undefined> {

		const adapterConfig = vscode.workspace.getConfiguration('jasmineExplorer', this.workspaceFolder.uri);
		const relativeConfigFilePath = adapterConfig.get<string>('config') || 'spec/support/jasmine.json';
		const configFilePath = path.resolve(this.workspaceFolder.uri.fsPath, relativeConfigFilePath);
		if (this.log.enabled) this.log.debug(`Using config file: ${configFilePath}`);

		let jasmineConfig: any;
		try {
			jasmineConfig = await fs.readJson(configFilePath);
		} catch (e) {
			return undefined;
		}

		const specDir = path.resolve(this.workspaceFolder.uri.fsPath, jasmineConfig.spec_dir);
		if (this.log.enabled) this.log.debug(`Using specDir: ${specDir}`);

		const testFileGlobs: IMinimatch[] = [];
		for (const relativeGlob of jasmineConfig.spec_files) {
			const absoluteGlob = path.resolve(this.workspaceFolder.uri.fsPath, jasmineConfig.spec_dir, relativeGlob);
			if (this.log.enabled) this.log.debug(`Using test file glob: ${absoluteGlob}`);
			testFileGlobs.push(new Minimatch(absoluteGlob));
		}

		const processEnv = process.env;
		const configEnv: { [prop: string]: any } = adapterConfig.get('env') || {};
		if (this.log.enabled) this.log.debug(`Using environment variable config: ${JSON.stringify(configEnv)}`);

		const env = { ...processEnv };

		for (const prop in configEnv) {
			const val = configEnv[prop];
			if ((val === undefined) || (val === null)) {
				delete env.prop;
			} else {
				env[prop] = String(val);
			}
		}

		let nodePath: string | undefined = adapterConfig.get<string>('nodePath') || undefined;
		if (nodePath === 'default') {
			nodePath = await detectNodePath();
		}
		if (this.log.enabled) this.log.debug(`Using nodePath: ${nodePath}`);

		let nodeArgv: string[] = adapterConfig.get<string[]>('nodeArgv') || [];
		if (this.log.enabled) this.log.debug(`Using node arguments: ${nodeArgv}`);

		const debuggerPort = adapterConfig.get<number>('debuggerPort') || 9229;

		const breakOnFirstLine: boolean = adapterConfig.get('breakOnFirstLine') || false;
		if (this.log.enabled) this.log.debug(`Using breakOnFirstLine: ${breakOnFirstLine}`);

		return { configFilePath, specDir, testFileGlobs, env, debuggerPort, nodePath, nodeArgv, breakOnFirstLine };
	}

	private collectNodesById(info: TestSuiteInfo | TestInfo): void {
		this.nodesById.set(info.id, info);
		if (info.type === 'suite') {
			for (const child of info.children) {
				this.collectNodesById(child);
			}
		}
	}

	private collectTestfiles(info: TestSuiteInfo | TestInfo, testfiles: Map<string, string>): void {
		if (info.type === 'suite') {
			for (const child of info.children) {
				this.collectTestfiles(child, testfiles);
			}
		} else {
			if (info.file) {
				testfiles.set(info.id, info.file);
			}
		}
	}

	private createDecorations(
		event: JasmineTestEvent,
		testfiles: Map<string, string>
	): TestDecoration[] {

		const testfile = testfiles.get(<string>event.test);
		const decorations: TestDecoration[] = [];

		if (testfile && event.failures) {

			if (this.log.enabled) this.log.info(`Adding ${event.failures.length} failure decorations to ${testfile}`);

			for (const failure of event.failures) {
				const decoration = this.createDecoration(failure, testfile);
				if (decoration) {
					decorations.push(decoration);
				}
			}
		}

		return decorations;
	}

	private createDecoration(
		failure: jasmine.FailedExpectation,
		testfile: string
	): TestDecoration | undefined {

		if (this.log.enabled) this.log.debug(`Trying to parse stack trace: ${JSON.stringify(failure.stack)}`);

		const error: Error = { name: '', message: '', stack: failure.stack };
		const stackFrames = parseStackTrace(error);

		for (const stackFrame of stackFrames) {
			if (stackFrame.getFileName() === testfile) {
				return {
					line: stackFrame.getLineNumber() - 1,
					message: failure.message
				}
			}
		}

		this.log.debug('No matching stack frame found');
		return undefined;
	}
}

interface LoadedConfig {
	configFilePath: string;
	specDir: string;
	testFileGlobs: IMinimatch[];
	debuggerPort: number;
	nodePath: string | undefined;
	nodeArgv: string[];
	env: { [prop: string]: any };
	breakOnFirstLine: boolean;
}

interface JasmineTestSuiteInfo extends TestSuiteInfo {
	isFileSuite?: boolean;
}

export interface JasmineTestEvent extends TestEvent {
	failures?: jasmine.FailedExpectation[] | undefined
}
