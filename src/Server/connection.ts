import { BufferReader, type NonEmptyArray, optionalImport } from '../Base/utils';
import { type RawServerOptions, type ServerData, parseServerOptions } from '../Base/options';
import BaseConnection from '../Base/connection';

interface SeekBzip {
	decode: (buffer: Buffer, uncompressedSize: number) => Buffer;
}

const seekBzip = optionalImport<SeekBzip>('seek-bzip');

// const MPS_IDS = Object.freeze([ 215, 240, 17550, 17700 ]);
interface GldSrcMultiPacket {
	ID: number;
	packets: {
		current: number;
		total: number;
	};
	goldSource: true;
	payload: Buffer;
}

interface SourceMultiPacket extends Omit<GldSrcMultiPacket, 'goldSource'> {
	goldSource: false;
	raw: Buffer;
	bzip?: {
		uncompressedSize: number;
		CRC32_sum: number;
	};
}

type MultiPacket = GldSrcMultiPacket | SourceMultiPacket;

function indexOf(buffer: Buffer, value: Buffer, maxIndex: number): number {
	// if(value.length > buffer.length) return -1;

	return buffer.subarray(0, maxIndex).indexOf(value);
}

const bzipStart = Buffer.from('BZh'); // 42 5a 68
const h = Buffer.from([0xFF, 0xFF, 0xFF, 0xFF]);
type PacketType = 'gldSrc' | 'src' | 'srcWithoutSize' | null;
function getMultiPacketType(buffer: Buffer, ID: number): PacketType { // works for first packet only
	let i = indexOf(buffer, h, 16);
	if(i === -1) return null;
	if(i === 9) return 'gldSrc';

	const currentPacket = buffer.readUInt8(9);
	if(currentPacket !== 0) return null;

	if(ID & 0x80000000){
		i = indexOf(buffer, bzipStart, 24) - 8;
		if(i === -1) return null;
	}

	if(i === 10) return 'srcWithoutSize';
	if(i === 12) return 'src';

	return null;
}

export default class Connection extends BaseConnection<ServerData> {
	private readonly packetsQueues = new Map<number, {
		list: Buffer[];
		totalPackets: number;
		type: PacketType;
	}>();

	protected handleMultiplePackets(buffer: Buffer): void {
		const packetID = buffer.readUInt32LE(4);

		if(!this.packetsQueues.has(packetID)){
			this.packetsQueues.set(packetID, {
				list: [],
				totalPackets: -1,
				type: null,
			});
		}

		const queue = this.packetsQueues.get(packetID)!;
		queue.list.push(buffer);

		if(queue.list.length === queue.totalPackets){
			const packets = queue.list.map(p => parsePacket(p, queue.type!)) as NonEmptyArray<MultiPacket>;

			let payload = Buffer.concat(
				packets.sort((p1, p2) => p1.packets.current - p2.packets.current)
					.map(p => p.payload)
			);

			if('bzip' in packets[0]){
				if(!seekBzip) throw new Error('optional dependency seek-bzip is not installed');

				payload = seekBzip.decode(payload, packets[0].bzip.uncompressedSize);
			}

			this.socket.emit('message', payload);
			this.packetsQueues.delete(packetID);
		}else{
			const packetType = getMultiPacketType(buffer, packetID);
			if(!packetType) return;

			if(queue.type) throw new Error('Multiple packets with different types');
			else{
				queue.type = packetType;
				queue.totalPackets = parsePacket(buffer, packetType).packets.total;
			}
		}
		// const hasSizeField = this.data.protocol !== 7 || !MPS_IDS.includes(this.data.appID);
	}

	public async makeQuery(command: (key?: Buffer) => Buffer, responseHeaders: readonly number[]): Promise<Buffer> {
		let buffer = await this.query(command(), responseHeaders);
		let attempt = 0;

		// if the response has a 0x41 header it means it needs challenge
		// some servers need multiple challenges to accept the query
		while(buffer[0] === 0x41 && attempt < 10){
			buffer = await this.query(command(buffer.subarray(1)), responseHeaders);
			attempt++;
		}

		if(buffer[0] === 0x41) throw new Error('Wrong server response');

		return buffer;
	}

	public static async init(options: RawServerOptions): Promise<Connection> {
		const data = await parseServerOptions(options);
		const connection = new Connection(data);
		await connection.connect();
		return connection;
	}
}

function parsePacket(buffer: Buffer, type: Exclude<PacketType, null>): MultiPacket {
	const reader = new BufferReader(buffer, 4);
	const ID = reader.long(), packets = reader.byte();

	if(type === 'gldSrc') return {
		ID,
		packets: {
			current: packets >> 4,
			total: packets & 0x0F,
		},
		payload: reader.remaining(),
		goldSource: true,
	};

	// @ts-expect-error payload is added later
	const packet: SourceMultiPacket = {
		ID,
		packets: {
			total: packets,
			current: reader.byte(),
		},
		goldSource: false,
		raw: buffer,
	};

	if(type === 'src') reader.addOffset(2); // skip maxPacketSize

	if(packet.packets.current === 0 && packet.ID & 0x80000000){
		packet.bzip = {
			uncompressedSize: reader.long(),
			CRC32_sum: reader.long(),
		};
	}

	packet.payload = reader.remaining();

	return packet;
}
