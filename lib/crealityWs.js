'use strict';

const { EventEmitter } = require('node:events');
const { isUnreachableError } = require('./helpers');

/**
 * @returns {typeof WebSocket}
 */
function getWebSocketImpl() {
	try {
		// optional dependency for older Node
		return require('ws');
	} catch {
		// ignore
	}
	if (typeof WebSocket !== 'undefined') {
		return WebSocket;
	}
	throw new Error('WebSocket missing — use Node.js >= 22 or install dependency "ws"');
}

/**
 * @param {any} socket
 * @param {string} event
 * @param {(...args: any[]) => void} handler
 */
function wsBind(socket, event, handler) {
	if (typeof socket.on === 'function') {
		socket.on(event, handler);
		return;
	}
	socket[`on${event}`] = ev => {
		if (event === 'message') {
			handler(ev && ev.data !== undefined ? ev.data : ev);
		} else if (event === 'error') {
			handler(ev && ev.error ? ev.error : ev);
		} else {
			handler(ev);
		}
	};
}

class CrealityWsClient extends EventEmitter {
	/**
	 * @param {{host: string, port: number, log: {info: Function, warn: Function, error: Function, debug: Function}}} opts
	 */
	constructor(opts) {
		super();
		this.host = opts.host;
		this.port = opts.port;
		this.log = opts.log;
		this.socket = null;
		this.reconnectTimer = null;
		this.stopping = false;
		this.reachable = true;
		this.telem = {};
	}

	start() {
		this.stopping = false;
		this.connect();
	}

	stop() {
		this.stopping = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.socket) {
			try {
				this.socket.close();
			} catch {
				// ignore
			}
			this.socket = null;
		}
	}

	/**
	 * @param {Record<string, any>} params
	 * @returns {Promise<void>}
	 */
	async set(params) {
		if (this.socket && this.socket.readyState === 1) {
			this.send({ method: 'set', params });
			return;
		}
		await this.oneshotSet(params);
	}

	/**
	 * @param {string|object} obj
	 */
	send(obj) {
		if (!this.socket || this.socket.readyState !== 1) {
			throw new Error('Creality WS not ready');
		}
		this.socket.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
	}

	/**
	 * @param {Record<string, any>} params
	 * @returns {Promise<void>}
	 */
	oneshotSet(params) {
		return new Promise((resolve, reject) => {
			let WS;
			try {
				WS = getWebSocketImpl();
			} catch (e) {
				reject(e);
				return;
			}
			const socket = new WS(`ws://${this.host}:${this.port}/`);
			const t = setTimeout(() => {
				try {
					socket.close();
				} catch {
					// ignore
				}
				reject(new Error('Creality WS Timeout'));
			}, 5000);
			wsBind(socket, 'open', () => {
				try {
					socket.send(JSON.stringify({ method: 'set', params }));
					clearTimeout(t);
					setTimeout(() => {
						try {
							socket.close();
						} catch {
							// ignore
						}
						resolve();
					}, 300);
				} catch (e) {
					clearTimeout(t);
					reject(e);
				}
			});
			wsBind(socket, 'error', err => {
				clearTimeout(t);
				reject(err && err.message ? err : new Error(String(err)));
			});
		});
	}

	connect() {
		if (this.stopping) {
			return;
		}
		let WS;
		try {
			WS = getWebSocketImpl();
		} catch (e) {
			this.log.error(e.message);
			return;
		}

		let socket;
		try {
			socket = new WS(`ws://${this.host}:${this.port}/`);
		} catch (e) {
			if (isUnreachableError(e)) {
				if (this.reachable) {
					this.log.info(`Creality WS unreachable: ${e.message}`);
					this.reachable = false;
				}
			} else {
				this.log.warn(`Creality WS open: ${e.message}`);
			}
			this.scheduleReconnect();
			return;
		}

		this.socket = socket;

		wsBind(socket, 'open', () => {
			if (!this.reachable) {
				this.log.info('Creality WS connected again');
			} else {
				this.log.info('Creality WS connected');
			}
			this.reachable = true;
			try {
				this.send({ method: 'get', params: { ReqPrinterPara: 1 } });
			} catch {
				// ignore
			}
			this.emit('open');
		});

		wsBind(socket, 'message', data => {
			const text = data && data.toString ? data.toString() : String(data);
			if (text === 'ok') {
				return;
			}
			let j;
			try {
				j = JSON.parse(text);
			} catch {
				return;
			}
			if (j && j.ModeCode === 'heart_beat') {
				try {
					this.send('ok');
				} catch {
					// ignore
				}
				return;
			}
			if (j && typeof j === 'object' && !Array.isArray(j)) {
				Object.assign(this.telem, j);
				this.emit('telem', j, this.telem);
			}
		});

		wsBind(socket, 'close', () => {
			this.socket = null;
			if (!this.stopping) {
				this.scheduleReconnect();
			}
		});

		wsBind(socket, 'error', err => {
			const msg = err && err.message ? err.message : String(err);
			if (isUnreachableError(err)) {
				if (this.reachable) {
					this.log.info(`Creality WS unreachable: ${msg}`);
					this.reachable = false;
				}
				return;
			}
			this.log.warn(`Creality WS error: ${msg}`);
		});
	}

	scheduleReconnect() {
		if (this.reconnectTimer || this.stopping) {
			return;
		}
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, 5000);
	}

	isOpen() {
		return !!(this.socket && this.socket.readyState === 1);
	}
}

module.exports = {
	CrealityWsClient,
};
