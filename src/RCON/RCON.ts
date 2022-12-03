import { EventEmitter } from 'events';
import { debug, BufferWriter } from '../utils';
import Connection from './connection';
import { parseRCONOptions, type RawRCONOptions } from '../options';

function makeCommand(ID: number, type: PacketType, body = ''): Buffer {
	return new BufferWriter()
		.long(Buffer.byteLength(body) + 10)
		.long(ID)
		.long(type)
		.string(body)
		.byte(0)
		.end();
}

export enum PacketType {
	Auth = 3,
	AuthResponse = 2,
	Command = 2,
	CommandResponse = 0,
}

export interface RCONPacket {
	size: number;
	ID: number;
	type: PacketType;
	body: string;
}

export default class RCON extends EventEmitter{
	private connection!: Connection;
	private _auth: Promise<void> | null = null;

	public async _ready(): Promise<void> {
		await this.connection._ready();

		if(this._auth === null){
			throw new Error('RCON: not authenticated.');
		}else await this._auth;
	}

	public async exec(command: string, multiPacket = false): Promise<string> {
		await this._ready();

		const ID = this._getID();

		await this.connection.send(makeCommand(ID, PacketType.Command, command));
		const packet = await this.connection.awaitResponse(PacketType.CommandResponse, ID);

		if(packet.body.length > 500 || multiPacket || command === 'status' || command === 'cvarlist'){ // multipacket response
			const ID2 = this._getID();
			await this.connection.send(makeCommand(ID2, 2));

			const packets: RCONPacket[] = [];
			const cb = (p: RCONPacket): void => {
				packets.push(p);
			};

			this.connection.socket.on('packet', cb);

			await this.connection.awaitResponse(PacketType.CommandResponse, ID2);
			this.connection.socket.off('packet', cb);

			return [packet.body, ...packets.map(p => p.body)].join('');
		}

		return packet.body;
	}

	public async authenticate(password: string): Promise<void> {
		if(this._auth !== null) return await this._auth;
		await this.connection._ready();

		if(typeof password !== 'string' || password === ''){
			throw new Error('RCON password must be a non-empty string');
		}

		const ID = this._getID();
		await this.connection.send(makeCommand(ID, PacketType.Auth, password));

		const EXEC_RESPONSE = this.connection.awaitResponse(PacketType.CommandResponse, ID);
		const AUTH_RESPONSE = this.connection.awaitResponse(PacketType.AuthResponse, ID);

		this._auth = (async () => {
			const firstResponse = await Promise.race([EXEC_RESPONSE, AUTH_RESPONSE]);

			if(firstResponse.type === 2){
				if(firstResponse.ID === -1){
					throw new Error('RCON: wrong password');
				}
			}else if((await AUTH_RESPONSE).ID === -1){
				throw new Error('RCON: wrong password');
			}
		})();

		await this._auth;
		this.connection.data.password = password;

		if(this.connection.data.debug) debug('RCON autenticated');
	}

	public async connect(options: RawRCONOptions): Promise<void> {
		const data = await parseRCONOptions(options);

		if(data.debug) debug('RCON connecting...');
		const connection = this.connection = new Connection(data);
		await connection._connected;

		const cb = (err?: Error): void => {
			if(this.connection.data.debug) debug('RCON disconnected.');

			connection.buffers = [];
			connection.remaining = 0;
			connection._connected = null;
			this._auth = null;

			this.emit(
				'disconnect',
				err ? err.message : 'The server closed the connection.'
			);
		};

		connection.socket
			.on('end', cb)
			.on('error', cb);

		if(data.debug) debug('RCON connected');
		await this.authenticate(data.password);
	}

	public async reconnect(): Promise<void> {
		if(this.connection._connected !== null) return;

		// Tiny delay to avoid "Error: Already connected" while reconnecting
		await new Promise(res => {
			setTimeout(res, 100);
		});
		if(this.connection.data.debug) debug('RCON reconnecting...');

		this.connection._connected = this.connection.awaitEvent('connect', 'Connection timeout.');

		this.connection.socket.connect(
			this.connection.data.port,
			this.connection.data.ip
		).unref();

		await this.connection._connected;
		if(this.connection.data.debug) debug('RCON connected');

		try{
			await this.authenticate(this.connection.data.password);
		}catch(e: unknown){
			this._auth = null;
			if(e instanceof Error && e.message !== 'RCON: wrong password') throw e;

			if(this.connection.data.debug) debug('RCON password changed.');
			this.emit('passwordChange');
		}
	}

	public destroy(): void {
		this.removeAllListeners();
		this.connection.socket.removeAllListeners();
		this.connection.socket.destroy();
	}

	private _lastID = 0x33333333;
	private _getID(): number {
		if(this._lastID === 0x80000000) this._lastID = -0x80000000;
		return this._lastID++;
	}
}
