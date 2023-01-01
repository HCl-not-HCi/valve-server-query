import { EventEmitter } from 'events';
import type Server from './server copy';
import type { AnyServerInfo, Players, Rules } from './parsers';
import type { NonEmptyArray } from '../Base/utils';

type InfoKeys = NonEmptyArray<keyof AnyServerInfo>;
type Player = Players['list'][number];

const queries = ['info', 'players', 'rules'] as const;

interface Options {
	watch: Array<'info' | 'players' | 'rules'>;
	interval: number;
}
type RawOptions = Partial<Options>;

export const DEFAULT_OPTIONS: Options = {
	watch: ['info', 'players'],
	interval: 30000,
};

function parseOptions(options: RawOptions, previousOptions: Options): Options {
	const data: Options = {
		...previousOptions,
		...options,
	};

	if(!Array.isArray(data.watch)){
		throw new Error('The watch option must be an array.');
	}else if(data.watch.some(item => !queries.includes(item))){
		throw new Error('The watch option must be an array with only "info", "players" or "rules".');
	}

	return data;
}

function diferentKeys<T extends object>(a: T, b: T): Array<keyof T> {
	const keys = Object.keys(a) as Array<keyof T>;

	return keys.filter(key => a[key] !== b[key] && typeof a[key] !== 'object');
}


interface Events {
	statusUpdate: (status: 'offline' | 'online') => void;

	infoUpdate: (oldInfo: AnyServerInfo, newInfo: AnyServerInfo, changed: InfoKeys) => void;
	playersUpdate: (oldPlayers: Players, newPlayers: Players) => void;
	rulesUpdate: (oldRules: Rules, newRules: Rules, changed: Array<number | string>) => void;

	playerJoin: (player: Player) => void;
	playerLeave: (player: Player) => void;

	update: () => void;
	error: (err: unknown) => void;
}

declare interface ServerWatch {
	on<T extends keyof Events>(event: T, listener: Events[T]): this;
	emit<T extends keyof Events>(event: T, ...args: Parameters<Events[T]>): boolean;
}

class ServerWatch extends EventEmitter {
	constructor(server: Server, options: RawOptions){
		super();
		this.options = parseOptions(options, DEFAULT_OPTIONS);
		this.server = server;

		this.resume();
	}
	private readonly server: Server;
	private options: Options;
	private interval: NodeJS.Timeout | null = null;

	public info!: AnyServerInfo;
	public players!: Players;
	public rules!: Rules;

	public setOptions(options: RawOptions): this {
		this.options = parseOptions(options, this.options);
		this.stop();
		this.resume();

		return this;
	}

	public stop(): void {
		if(this.interval) clearInterval(this.interval);
	}

	public resume(): void {
		if(this.interval) throw new Error('The watch is already running.');
		if(this.options.interval === 0) return;

		this.update();
		this.interval = setInterval(() => this.update(), this.options.interval);

		if(this._ref) this.interval.ref();
		else this.interval.unref();
	}

	private update(): void {
		Promise.all(
			this.options.watch.map(x => this[`update_${x}`]())
		)
			.catch(err => this.emit('error', err))
			.finally(() => this.emit('update'));
	}

	private async update_info(): Promise<void> {
		const oldInfo = this.info;
		this.info = await this.server.getInfo();

		const changed = diferentKeys(oldInfo, this.info);
		if(changed.length){
			this.emit('infoUpdate', oldInfo, this.info, changed as InfoKeys);
		}
	}

	private async update_players(): Promise<void> {
		const oldPlayers = this.players;
		this.players = await this.server.getPlayers();
		let playersChanged = false;

		for(const p of oldPlayers.list){
			if(!this.players.list.some(p2 => p2.name === p.name)){
				playersChanged = true;
				this.emit('playerLeave', p);
			}
		}

		for(const p of this.players.list){
			if(!oldPlayers.list.some(p2 => p2.name === p.name)){
				playersChanged = true;
				this.emit('playerJoin', p);
			}
		}

		if(playersChanged){
			this.emit('playersUpdate', oldPlayers, this.players);
		}
	}

	private async update_rules(): Promise<void> {
		const oldRules = this.rules;
		this.rules = await this.server.getRules();

		const changed = diferentKeys(oldRules, this.rules);
		if(changed.length){
			this.emit('rulesUpdate', oldRules, this.rules, changed);
		}
	}

	private _ref = true;
	public unref(): void {
		this._ref = false;
		if(this.interval) this.interval.unref();
	}

	public ref(): void {
		this._ref = true;
		if(this.interval) this.interval.ref();
	}
}

export default ServerWatch;