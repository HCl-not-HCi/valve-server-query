/* eslint-disable no-console */
import { resolve as resolveDNS } from 'dns';
import { isIP } from 'net';

export async function resolveIP(str: string): Promise<string> {
	if(typeof str !== 'string'){
		throw Error("'options.ip' must be a string");
	}else if(isIP(str) === 0){
		const error = new Error('Invalid IP/Hostname');

		[str] = await new Promise((res, rej) => {
			resolveDNS(str, (err, addresses) => {
				if(err !== null || addresses.length === 0){
					return rej(error);
				}

				res(addresses as [string]);
			});
		});
	}

	const ipFormat = isIP(str);
	if(ipFormat === 0){
		throw Error('Invalid IP/Hostname');
	}else if(ipFormat === 6){
		console.log('IPv6 is easy to support, but i decided to not support it for now, cause i have never seen an ipv6 server');
		console.log('If you need it, you can create an issue on github');
		throw new Error('IPv6 is not supported');
	}

	return str;
}

export class BufferWriter{
	private readonly buffer: number[] = [];

	public string(value: string, encoding: BufferEncoding = 'ascii'): this {
		return this.byte(
			...Buffer.from(value, encoding), 0
		);
	}

	public byte(...values: number[]): this {
		this.buffer.push(...values);

		return this;
	}

	public long(number: number): this {
		const buf = Buffer.alloc(4);
		buf.writeInt32LE(number);

		return this.byte(...buf);
	}

	public end(): Buffer {
		return Buffer.from(this.buffer);
	}
}

export class BufferReader{
	constructor(bufferParser: Buffer, offset = 0){
		this.raw = bufferParser;
		this.offset = offset;
	}
	private readonly raw: Buffer;
	private offset = 0;

	public byte(): number {
		return this.raw.readUInt8(this.offset++);
	}

	public short(unsigned = false, endianess = 'LE'): number {
		this.offset += 2;

		// eslint-disable-next-line @typescript-eslint/no-unsafe-call
		return this.raw[
			`read${unsigned ? 'U' : ''}Int16${endianess}`
		](this.offset - 2) as number;
	}

	public long(): number {
		this.offset += 4;
		return this.raw.readInt32LE(this.offset - 4);
	}

	public float(): number {
		this.offset += 4;
		return this.raw.readFloatLE(this.offset - 4);
	}

	public bigUInt(): bigint {// long long
		this.offset += 8;
		return this.raw.readBigUInt64LE(this.offset - 8);
	}

	public string(encoding: BufferEncoding = 'ascii'): string {
		const stringEndIndex = this.raw.indexOf(0, this.offset);
		if(stringEndIndex === -1) throw new Error('string not terminated');

		const string = this.raw.slice(this.offset, stringEndIndex)
			.toString(encoding);

		this.offset = stringEndIndex + 1;

		return string;
	}

	public char(): string {
		return this.raw.slice(
			this.offset++, this.offset
		).toString();
	}

	public remaining(): Buffer {
		return this.raw.slice(this.offset);
	}
}

export type BufferLike = Buffer | number[] | string;
export function debug(
	type: string,
	string: string,
	thing?: BufferLike
): void {
	string = `\x1B[33m${type} ${string}\x1B[0m`;
	if(thing instanceof Buffer){
		const parts = Buffer.from(thing)
			.toString('hex')
			.match(/../g) as string[];

		for(let i = 0; i < parts.length; i++){
			if(
				parts[i - 1] !== '00' &&
				parts[i + 0] === '00' &&
				parts[i + 1] === '00' &&
				parts[i + 2] !== '00'
			){
				parts[i] = '\x1B[31m00';
				parts[++i] = '00\x1B[0m';
			}
		}

		if(thing.length > 30){
			console.log(string, `<Buffer ${
				parts.slice(0, 20).join(' ')
			} ...${thing.length - 20} bytes>`, '\n');
		}else{
			console.log(string, `<Buffer ${
				parts.join(' ')
			}>`, '\n');
		}
	}else if(typeof thing === 'string'){
		console.log(string, thing, '\n');
	}else{
		console.log(string, '\n');
	}
}

export { default as decompressBZip } from './Bzip2';