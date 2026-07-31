/**
 * ioBroker Javascript – Creality SPARKX i7 / Moonraker (schlank)
 *
 * Struktur:
 *   sparkx.*                    Druck / Online / aktives Filament
 *   sparkx.temp.*               Düsen- und Bett-Temperaturen
 *   sparkx.fans.*               Lüfter (lesen)
 *   sparkx.cfs.*                CFS-Übersicht + Slots
 *   sparkx.control.light         Druckkopf-LED
 *   sparkx.control.pause|resume|stop   Drucksteuerung (Buttons)
 *   sparkx.cfs.light             CFS-Box-LED
 */

const http = require('http');

// ========== Konfiguration ==========
const HOST = '192.168.150.175';
const PORT = 7125; // Moonraker; bei leerer Antwort: 4408
const CREALITY_WS_PORT = 9999; // Creality-WebSocket (Druckkopf-LED u.a.)
const PREFIX = '0_userdata.0.creality.sparkx';
const TEMP_PREFIX = `${PREFIX}.temp`;
const FANS_PREFIX = `${PREFIX}.fans`;
const CFS_PREFIX = `${PREFIX}.cfs`;
const CONTROL_PREFIX = `${PREFIX}.control`;
const INTERVAL_MS = 5000;
const HTTP_TIMEOUT_MS = 15000; // unter Last (Nivellierung/Druck) oft >4s
const API_KEY = ''; // optional aus moonraker.conf
const CFS_SLOTS = ['T1A', 'T1B', 'T1C', 'T1D']; // CFS lite: eine Box, 4 Slots
// ===================================

/** Schlanke Abfrage zuerst; CFS separat (schwerer) */
const QUERY_CORE =
    '/printer/objects/query?print_stats&display_status&virtual_sdcard' +
    '&extruder&heater_bed' +
    '&fan_feedback&heater_fan%20hotend_fan' +
    '&output_pin%20fan0&output_pin%20board_fan&output_pin%20e_fan';
const QUERY_CFS =
    '/printer/objects/query?box&filament_inventory_manager';

let lastFilename = '';
let estimatedTime = 0;
let timer = null;
let crealityWs = null;
let crealityWsReconnect = null;
let crealityWsStopping = false;
/** Letzte Creality-WS-Telemetrie (partial updates mergen) */
let crealityTelem = {};
let lastKlipperState = 'standby';
/** true = Moonraker zuletzt erreichbar; verhindert Log-Spam bei ausgeschaltetem Drucker */
let moonrakerReachable = true;
let crealityWsReachable = true;

/** SPARKX i7: selfTestStep während Vorprüfung (UI „Nivellierung“ u.a.) */
const SELF_TEST_STEP_LABELS = {
    5: 'leveling',
};

function isUnreachableError(err) {
    const msg = err && err.message ? String(err.message) : String(err || '');
    return /EHOSTUNREACH|ECONNREFUSED|ENETUNREACH|ETIMEDOUT|Timeout|ENOTFOUND|ECONNRESET/i.test(msg);
}

/**
 * Verbindungsfehler nur einmal loggen (info), Wiederkehr ebenfalls einmal.
 * Andere Fehler weiterhin als warn.
 */
function logMoonrakerUnreachable(err) {
    const msg = err && err.message ? err.message : String(err);
    if (isUnreachableError(err)) {
        if (moonrakerReachable) {
            log(`Creality Moonraker nicht erreichbar: ${msg}`, 'info');
            moonrakerReachable = false;
        }
        return;
    }
    log(`Creality poll: ${msg}`, 'warn');
}

function logMoonrakerReachableAgain() {
    if (!moonrakerReachable) {
        log('Creality Moonraker wieder erreichbar', 'info');
        moonrakerReachable = true;
    }
}

function formatHms(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return [
        String(h).padStart(2, '0'),
        String(m).padStart(2, '0'),
        String(s).padStart(2, '0'),
    ].join(':');
}

function formatFinishAt(remainingSec) {
    if (!Number.isFinite(remainingSec) || remainingSec <= 0) return '';
    const end = new Date(Date.now() + remainingSec * 1000);
    return [
        String(end.getHours()).padStart(2, '0'),
        String(end.getMinutes()).padStart(2, '0'),
    ].join(':');
}

function rawName(filename) {
    if (!filename) return '';
    return filename.split('/').pop();
}

function shortName(filename) {
    const raw = rawName(filename);
    if (!raw) return '';
    const m = raw.match(/^(.+?)\.stl/i);
    return m ? m[1] : raw.replace(/\.gcode$/i, '');
}

/**
 * UI-Status: Creality-WS ist genauer während Kalibrierung/Nivellierung,
 * Moonraker print_stats bleibt dort oft auf „standby“.
 */
function mapUiState(klipperState, ct) {
    ct = ct || {};
    const errCode = ct.err && ct.err.errcode != null ? Number(ct.err.errcode) : 0;
    if (errCode !== 0) return 'error';

    const withSelf = Number(ct.withSelfTest) || 0;
    if (withSelf >= 1 && withSelf <= 99) {
        const step = Number(ct.selfTestStep);
        return SELF_TEST_STEP_LABELS[step] || 'self-testing';
    }

    const st = ct.state != null ? Number(ct.state) : NaN;
    const fname = ct.printFileName ? String(ct.printFileName) : '';
    let progress = Number(
        ct.printProgress != null ? ct.printProgress : ct.dProgress,
    );
    if (!Number.isFinite(progress)) progress = -1;

    if (fname) {
        if (progress >= 100) return 'complete';
        if (st === 5) return 'paused';
        if (st === 4) return 'stopped';
        if (st === 1) return 'printing';
        if (st === 0) return 'preparing';
        if (Number(ct.deviceState) > 0) return 'preparing';
    }

    if (klipperState && klipperState !== 'standby' && klipperState !== 'unknown') {
        return klipperState;
    }

    return klipperState || 'standby';
}

function publishUiState(klipperState) {
    if (klipperState != null) lastKlipperState = klipperState;
    const ui = mapUiState(lastKlipperState, crealityTelem);
    setState(`${PREFIX}.state`, ui, true);
    setState(`${PREFIX}.stateKlipper`, lastKlipperState || '', true);
    const step = crealityTelem.selfTestStep;
    setState(
        `${PREFIX}.selfTestStep`,
        step != null && step !== '' ? Number(step) : 0,
        true,
    );
}

/** Fortschritt / Restzeit aus Creality-WS (Fallback wenn Moonraker hängt) */
function publishProgressFromCreality() {
    const ct = crealityTelem;
    let progress = Number(ct.printProgress != null ? ct.printProgress : ct.dProgress);
    if (!Number.isFinite(progress) || progress < 0) return;

    setState(`${PREFIX}.progress`, Math.round(progress * 10) / 10, true);

    let remainingSec = Number(ct.printLeftTime);
    if (!Number.isFinite(remainingSec) || remainingSec < 0) remainingSec = 0;

    const ui = mapUiState(lastKlipperState, ct);
    if (ui === 'printing' || ui === 'paused' || ui === 'leveling' || ui === 'self-testing' || ui === 'preparing') {
        setState(`${PREFIX}.remainingText`, formatHms(remainingSec), true);
        setState(`${PREFIX}.finishAt`, formatFinishAt(remainingSec), true);
    }

    const fname = ct.printFileName ? String(ct.printFileName) : '';
    if (fname) {
        setState(`${PREFIX}.printName`, rawName(fname), true);
        setState(`${PREFIX}.printNameShort`, shortName(fname), true);
    }
}

/** Creality liefert oft 0RRGGBB → #RRGGBB */
function normalizeColor(raw) {
    if (raw == null || raw === '' || raw === '-1' || raw === 'None') return '';
    let c = String(raw).replace(/^#/, '');
    if (c.length === 7 && c.startsWith('0')) c = c.slice(1);
    if (c.length === 6) return `#${c.toUpperCase()}`;
    return c ? `#${c}` : '';
}

function round1(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return null;
    return Math.round(v * 10) / 10;
}

function materialLookup(box) {
    const map = {};
    if (!box || !Array.isArray(box.same_material)) return map;
    for (const row of box.same_material) {
        const color = normalizeColor(row[1]);
        const material = row[3] || '';
        for (const s of row[2] || []) {
            map[String(s).toUpperCase()] = { material, color };
        }
    }
    return map;
}

function resolveActiveSlot(box, inv) {
    const tnn = inv && inv.active_tnn ? String(inv.active_tnn).toUpperCase() : '';
    if (/^T\d[A-D]$/.test(tnn)) return tnn;

    if (box && box.filament && box[`T${box.filament}`]) {
        const letter = String(box[`T${box.filament}`].filament || '').toUpperCase();
        if (/^[A-D]$/.test(letter)) return `T${box.filament}${letter}`;
    }
    return '';
}

/** Alle CFS-Slots + aktives Filament */
function parseCfs(box, inv) {
    const matMap = materialLookup(box);
    const activeSlot = resolveActiveSlot(box, inv);
    const t1 = (box && box.T1) || {};
    const slots = {};

    for (let i = 0; i < 4; i++) {
        const id = CFS_SLOTS[i];
        const colorRaw = Array.isArray(t1.color_value) ? t1.color_value[i] : null;
        const fromMap = matMap[id] || {};
        const color = normalizeColor(colorRaw) || fromMap.color || '';
        const material = fromMap.material || '';
        const occupied = !!(color || material);

        slots[id] = {
            color,
            material,
            occupied,
            active: id === activeSlot,
        };
    }

    const active = slots[activeSlot] || { color: '', material: '', occupied: false };

    return {
        type: (box && box.type) || '',
        state: (box && box.state) || '',
        enable: !!(box && box.enable),
        temperature: t1.temperature != null && t1.temperature !== 'None' ? Number(t1.temperature) : null,
        humidity: t1.dry_and_humidity != null && t1.dry_and_humidity !== 'None'
            ? Number(t1.dry_and_humidity)
            : null,
        activeSlot,
        activeColor: active.color || '',
        activeMaterial: active.material || '',
        slots,
    };
}

function httpGetJson(pathAndQuery) {
    return httpJson('GET', pathAndQuery, null);
}

function httpJson(method, pathAndQuery, bodyObj) {
    return new Promise((resolve, reject) => {
        const body = bodyObj != null ? JSON.stringify(bodyObj) : null;
        const opts = {
            host: HOST,
            port: PORT,
            path: pathAndQuery,
            method,
            timeout: HTTP_TIMEOUT_MS,
            headers: {},
        };
        if (API_KEY) opts.headers['X-Api-Key'] = API_KEY;
        if (body) {
            opts.headers['Content-Type'] = 'application/json';
            opts.headers['Content-Length'] = Buffer.byteLength(body);
        }

        const req = http.request(opts, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
                    return;
                }
                if (!data) {
                    resolve(null);
                    return;
                }
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`JSON parse: ${e.message}`));
                }
            });
        });
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

/** G-Code an den Drucker senden (Moonraker) */
async function sendGcode(script) {
    await httpJson('POST', '/printer/gcode/script', { script });
}

/** WebSocket-Implementierung: npm „ws“ oder globales WebSocket (Node 22+) */
function getWebSocketImpl() {
    try {
        return require('ws');
    } catch (e) {
        // ignore
    }
    if (typeof WebSocket !== 'undefined') return WebSocket;
    throw new Error(
        'WebSocket fehlt – im Javascript-Adapter unter „zusätzliche npm-Module“ ws eintragen',
    );
}

function wsBind(socket, event, handler) {
    if (typeof socket.on === 'function') {
        socket.on(event, handler);
        return;
    }
    // Browser-/Node-WebSocket API
    const key = `on${event}`;
    socket[key] = (ev) => {
        if (event === 'message') handler(ev && ev.data !== undefined ? ev.data : ev);
        else if (event === 'error') handler(ev && ev.error ? ev.error : ev);
        else handler(ev);
    };
}

function crealityWsSend(obj) {
    if (!crealityWs) throw new Error('Creality WS nicht verbunden');
    if (crealityWs.readyState !== 1) throw new Error('Creality WS nicht bereit');
    crealityWs.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

function connectCrealityWs() {
    if (crealityWsStopping) return;
    let WS;
    try {
        WS = getWebSocketImpl();
    } catch (e) {
        log(e.message, 'error');
        return;
    }

    const url = `ws://${HOST}:${CREALITY_WS_PORT}/`;
    let socket;
    try {
        socket = new WS(url);
    } catch (e) {
        if (isUnreachableError(e)) {
            if (crealityWsReachable) {
                log(`Creality WS nicht erreichbar: ${e.message}`, 'info');
                crealityWsReachable = false;
            }
        } else {
            log(`Creality WS open: ${e.message}`, 'warn');
        }
        scheduleCrealityWsReconnect();
        return;
    }
    crealityWs = socket;

    wsBind(socket, 'open', () => {
        if (!crealityWsReachable) {
            log('Creality WS wieder verbunden', 'info');
        } else {
            log('Creality WS verbunden', 'info');
        }
        crealityWsReachable = true;
        try {
            crealityWsSend({ method: 'get', params: { ReqPrinterPara: 1 } });
        } catch (e) {
            // ignore
        }
    });

    wsBind(socket, 'message', (data) => {
        const text = data && data.toString ? data.toString() : String(data);
        if (text === 'ok') return;
        let j;
        try {
            j = JSON.parse(text);
        } catch (e) {
            return;
        }
        if (j && j.ModeCode === 'heart_beat') {
            try {
                crealityWsSend('ok');
            } catch (e) {
                // ignore
            }
            return;
        }
        if (j && typeof j === 'object' && !Array.isArray(j)) {
            Object.assign(crealityTelem, j);
            if (j.lightSw !== undefined) {
                setState(`${CONTROL_PREFIX}.light`, Number(j.lightSw) > 0, true);
            }
            if (
                j.state !== undefined
                || j.deviceState !== undefined
                || j.withSelfTest !== undefined
                || j.selfTestStep !== undefined
                || j.printProgress !== undefined
                || j.dProgress !== undefined
                || j.printLeftTime !== undefined
                || j.printFileName !== undefined
                || j.err !== undefined
            ) {
                publishUiState(null);
                publishProgressFromCreality();
            }
        }
    });

    wsBind(socket, 'close', () => {
        crealityWs = null;
        if (!crealityWsStopping) scheduleCrealityWsReconnect();
    });

    wsBind(socket, 'error', (err) => {
        const msg = err && err.message ? err.message : String(err);
        if (isUnreachableError(err)) {
            if (crealityWsReachable) {
                log(`Creality WS nicht erreichbar: ${msg}`, 'info');
                crealityWsReachable = false;
            }
            return;
        }
        log(`Creality WS Fehler: ${msg}`, 'warn');
    });
}

function scheduleCrealityWsReconnect() {
    if (crealityWsReconnect || crealityWsStopping) return;
    crealityWsReconnect = setTimeout(() => {
        crealityWsReconnect = null;
        connectCrealityWs();
    }, 5000);
}

function stopCrealityWs() {
    crealityWsStopping = true;
    if (crealityWsReconnect) {
        clearTimeout(crealityWsReconnect);
        crealityWsReconnect = null;
    }
    if (crealityWs) {
        try {
            crealityWs.close();
        } catch (e) {
            // ignore
        }
        crealityWs = null;
    }
}

/** Parameter über Creality-WebSocket setzen (lightSw, pause, stop, …) */
async function crealitySet(params) {
    if (crealityWs && crealityWs.readyState === 1) {
        crealityWsSend({ method: 'set', params });
        return;
    }
    await new Promise((resolve, reject) => {
        let WS;
        try {
            WS = getWebSocketImpl();
        } catch (e) {
            reject(e);
            return;
        }
        const socket = new WS(`ws://${HOST}:${CREALITY_WS_PORT}/`);
        const t = setTimeout(() => {
            try { socket.close(); } catch (e) { /* ignore */ }
            reject(new Error('Creality WS Timeout'));
        }, 5000);
        wsBind(socket, 'open', () => {
            try {
                socket.send(JSON.stringify({ method: 'set', params }));
                clearTimeout(t);
                setTimeout(() => {
                    try { socket.close(); } catch (e) { /* ignore */ }
                    resolve();
                }, 300);
            } catch (e) {
                clearTimeout(t);
                reject(e);
            }
        });
        wsBind(socket, 'error', (err) => {
            clearTimeout(t);
            reject(err && err.message ? err : new Error(String(err)));
        });
    });
}

async function setHeadLight(on) {
    await crealitySet({ lightSw: on ? 1 : 0 });
}

/** Pin-Wert 0..1 (oder 0..255) → Prozent */
function pinToPercent(val) {
    const v = Number(val);
    if (!Number.isFinite(v)) return 0;
    if (v <= 1) return Math.round(v * 1000) / 10;
    return Math.round((v / 255) * 1000) / 10;
}

async function createDp(dp, init, common) {
    await createStateAsync(dp, init, {
        read: true,
        write: false,
        role: common.role || (common.type === 'boolean' ? 'indicator' : 'value'),
        desc: `Creality SPARKX – ${common.name}`,
        ...common,
    });
    log(`State ok: ${dp}`, 'info');
}

async function ensureStates() {
    const root = [
        ['state', 'string', 'Druckstatus (UI)', ''],
        ['stateKlipper', 'string', 'Druckstatus (Klipper/Moonraker)', ''],
        ['selfTestStep', 'number', 'Self-Test Schritt', 0],
        ['progress', 'number', 'Fortschritt %', 0],
        ['printName', 'string', 'Druckteil (RAW)', ''],
        ['printNameShort', 'string', 'Druckteil (kurz)', ''],
        ['remainingText', 'string', 'Restzeit', '00:00:00'],
        ['finishAt', 'string', 'Fertig um', ''],
        ['online', 'boolean', 'Online', false],
        ['filamentSlot', 'string', 'Filament aktiv – Slot', ''],
        ['filamentMaterial', 'string', 'Filament aktiv – Material', ''],
        ['filamentColor', 'string', 'Filament aktiv – Farbe', ''],
    ];

    for (const [id, type, name, init, unit] of root) {
        await createDp(`${PREFIX}.${id}`, init, { name, type, unit });
    }

    const temps = [
        ['nozzleTemp', 'number', 'Düse Ist °C', 0, '°C'],
        ['nozzleTarget', 'number', 'Düse Soll °C', 0, '°C'],
        ['bedTemp', 'number', 'Bett Ist °C', 0, '°C'],
        ['bedTarget', 'number', 'Bett Soll °C', 0, '°C'],
    ];
    for (const [id, type, name, init, unit] of temps) {
        await createDp(`${TEMP_PREFIX}.${id}`, init, { name, type, unit });
    }

    const fans = [
        ['partCooling', 'number', 'Bauteilkühlung %', 0, '%'],
        ['partCoolingRpm', 'number', 'Bauteilkühlung RPM', 0, 'rpm'],
        ['hotend', 'number', 'Hotend-Lüfter %', 0, '%'],
        ['board', 'number', 'Board-Lüfter %', 0, '%'],
        ['aux', 'number', 'Aux-/E-Lüfter %', 0, '%'],
    ];
    for (const [id, type, name, init, unit] of fans) {
        await createDp(`${FANS_PREFIX}.${id}`, init, { name, type, unit });
    }

    // Druckkopf-/Arbeits-LED (Creality WS lightSw @ :9999)
    await createDp(`${CONTROL_PREFIX}.light`, false, {
        name: 'Druckkopf LED',
        type: 'boolean',
        write: true,
        role: 'switch',
    });

    // Drucksteuerung (VIS: Button → true tippen)
    const printBtns = [
        ['pause', 'Pause'],
        ['resume', 'Weiter (nach Pause)'],
        ['stop', 'Stop / Abbrechen'],
    ];
    for (const [id, name] of printBtns) {
        await createDp(`${CONTROL_PREFIX}.${id}`, false, {
            name,
            type: 'boolean',
            write: true,
            role: 'button',
        });
    }

    // CFS-Box-LED (Moonraker LED_SWITCH)
    await createDp(`${CFS_PREFIX}.light`, false, {
        name: 'CFS Box LED',
        type: 'boolean',
        write: true,
        role: 'switch',
    });

    const cfsRoot = [
        ['type', 'string', 'CFS Typ', ''],
        ['state', 'string', 'CFS Status', ''],
        ['enable', 'boolean', 'CFS aktiviert', false],
        ['temperature', 'number', 'CFS Temperatur °C', 0, '°C'],
        ['humidity', 'number', 'CFS Luftfeuchte %', 0, '%'],
    ];
    for (const [id, type, name, init, unit] of cfsRoot) {
        await createDp(`${CFS_PREFIX}.${id}`, init, { name, type, unit });
    }

    for (const slot of CFS_SLOTS) {
        await createDp(`${CFS_PREFIX}.${slot}.color`, '', {
            name: `${slot} Farbe`,
            type: 'string',
        });
        await createDp(`${CFS_PREFIX}.${slot}.material`, '', {
            name: `${slot} Material`,
            type: 'string',
        });
        await createDp(`${CFS_PREFIX}.${slot}.occupied`, false, {
            name: `${slot} belegt`,
            type: 'boolean',
        });
        await createDp(`${CFS_PREFIX}.${slot}.active`, false, {
            name: `${slot} aktiv`,
            type: 'boolean',
        });
    }
}

function bindControls() {
    on({ id: `${CONTROL_PREFIX}.light`, change: 'ne', ack: false }, async (obj) => {
        if (!obj || !obj.state) return;
        const wantOn = !!obj.state.val;
        try {
            await setHeadLight(wantOn);
            setState(`${CONTROL_PREFIX}.light`, wantOn, true);
            log(`Druckkopf LED → ${wantOn ? 'AN' : 'AUS'}`, 'info');
        } catch (e) {
            log(`Druckkopf LED steuern fehlgeschlagen: ${e.message}`, 'error');
            setState(`${CONTROL_PREFIX}.light`, !wantOn, true);
        }
    });

    on({ id: `${CONTROL_PREFIX}.pause`, change: 'ne', ack: false }, async (obj) => {
        if (!obj || !obj.state || !obj.state.val) {
            setState(`${CONTROL_PREFIX}.pause`, false, true);
            return;
        }
        try {
            await crealitySet({ pause: 1 });
            log('Druck → Pause', 'info');
        } catch (e) {
            try {
                await sendGcode('PAUSE');
                log('Druck → Pause (Moonraker Fallback)', 'info');
            } catch (e2) {
                log(`Pause fehlgeschlagen: ${e.message}`, 'error');
            }
        }
        setState(`${CONTROL_PREFIX}.pause`, false, true);
    });

    on({ id: `${CONTROL_PREFIX}.resume`, change: 'ne', ack: false }, async (obj) => {
        if (!obj || !obj.state || !obj.state.val) {
            setState(`${CONTROL_PREFIX}.resume`, false, true);
            return;
        }
        try {
            await crealitySet({ pause: 0 });
            log('Druck → Weiter', 'info');
        } catch (e) {
            try {
                await sendGcode('RESUME');
                log('Druck → Weiter (Moonraker Fallback)', 'info');
            } catch (e2) {
                log(`Weiter fehlgeschlagen: ${e.message}`, 'error');
            }
        }
        setState(`${CONTROL_PREFIX}.resume`, false, true);
    });

    on({ id: `${CONTROL_PREFIX}.stop`, change: 'ne', ack: false }, async (obj) => {
        if (!obj || !obj.state || !obj.state.val) {
            setState(`${CONTROL_PREFIX}.stop`, false, true);
            return;
        }
        try {
            await crealitySet({ stop: 1 });
            log('Druck → Stop', 'info');
        } catch (e) {
            try {
                await sendGcode('CANCEL_PRINT');
                log('Druck → Stop (Moonraker Fallback)', 'info');
            } catch (e2) {
                log(`Stop fehlgeschlagen: ${e.message}`, 'error');
            }
        }
        setState(`${CONTROL_PREFIX}.stop`, false, true);
    });

    on({ id: `${CFS_PREFIX}.light`, change: 'ne', ack: false }, async (obj) => {
        if (!obj || !obj.state) return;
        const wantOn = !!obj.state.val;
        try {
            await sendGcode(`LED_SWITCH SWITCH=${wantOn ? 1 : 0}`);
            setState(`${CFS_PREFIX}.light`, wantOn, true);
            log(`CFS Box LED → ${wantOn ? 'AN' : 'AUS'}`, 'info');
        } catch (e) {
            log(`CFS Box LED steuern fehlgeschlagen: ${e.message}`, 'error');
            setState(`${CFS_PREFIX}.light`, !wantOn, true);
        }
    });
}

async function fetchMetadata(filename) {
    if (!filename) {
        estimatedTime = 0;
        return;
    }
    try {
        const q = `/server/files/metadata?filename=${encodeURIComponent(filename)}`;
        const data = await httpGetJson(q);
        estimatedTime = Number(data && data.result && data.result.estimated_time) || 0;
    } catch (e) {
        if (!isUnreachableError(e)) {
            log(`Creality metadata: ${e.message}`, 'warn');
        }
        estimatedTime = 0;
    }
}

function calcRemaining(state, progress01, printDuration) {
    if (state !== 'printing' && state !== 'paused') return 0;

    let remaining = 0;
    if (estimatedTime > 0 && progress01 > 0) {
        remaining = estimatedTime * (1 - progress01);
    } else if (estimatedTime > 0) {
        remaining = estimatedTime - printDuration;
    } else if (progress01 > 0.01) {
        remaining = printDuration / progress01 - printDuration;
    }
    return Math.max(0, remaining);
}

async function poll() {
    try {
        const data = await httpGetJson(QUERY_CORE);
        const st = (data && data.result && data.result.status) || {};
        const ps = st.print_stats || {};
        const ds = st.display_status || {};
        const vs = st.virtual_sdcard || {};
        const ex = st.extruder || {};
        const bed = st.heater_bed || {};
        const fb = st.fan_feedback || {};
        const fan0 = st['output_pin fan0'] || {};
        const boardFan = st['output_pin board_fan'] || {};
        const eFan = st['output_pin e_fan'] || {};
        const hotendFan = st['heater_fan hotend_fan'] || {};

        // CFS separat — darf scheitern, ohne Kern-Daten zu blockieren
        let cfs = {
            type: '', state: '', enable: false,
            temperature: null, humidity: null,
            activeSlot: '', activeColor: '', activeMaterial: '',
            slots: {},
        };
        try {
            const cfsData = await httpGetJson(QUERY_CFS);
            const cst = (cfsData && cfsData.result && cfsData.result.status) || {};
            cfs = parseCfs(cst.box, cst.filament_inventory_manager);
        } catch (e) {
            if (!isUnreachableError(e)) {
                log(`Creality CFS poll: ${e.message}`, 'warn');
            }
        }

        const state = ps.state || 'unknown';
        const filename = ps.filename || '';
        let progress01 = Number(
            ds.progress != null ? ds.progress : (vs.progress != null ? vs.progress : 0),
        );
        // Creality-WS oft aktueller als Moonraker display_status
        const ctProg = Number(
            crealityTelem.printProgress != null
                ? crealityTelem.printProgress
                : crealityTelem.dProgress,
        );
        if ((!progress01 || progress01 <= 0) && Number.isFinite(ctProg) && ctProg > 0) {
            progress01 = ctProg / 100;
        }
        const progress = Math.round(progress01 * 1000) / 10;
        const printDuration = Number(ps.print_duration) || 0;

        if (filename && filename !== lastFilename) {
            lastFilename = filename;
            await fetchMetadata(filename);
        }
        if (!filename) {
            lastFilename = '';
            estimatedTime = 0;
        }

        let remainingSec = calcRemaining(state, progress01, printDuration);
        const ctLeft = Number(crealityTelem.printLeftTime);
        if ((!remainingSec || remainingSec <= 0) && Number.isFinite(ctLeft) && ctLeft > 0) {
            remainingSec = ctLeft;
        }

        setState(`${PREFIX}.online`, true, true);
        logMoonrakerReachableAgain();
        publishUiState(state);
        setState(`${PREFIX}.progress`, progress, true);
        setState(`${PREFIX}.printName`, rawName(filename), true);
        setState(`${PREFIX}.printNameShort`, shortName(filename), true);
        setState(`${PREFIX}.remainingText`, formatHms(remainingSec), true);
        setState(`${PREFIX}.finishAt`, formatFinishAt(remainingSec), true);

        setState(`${TEMP_PREFIX}.nozzleTemp`, round1(ex.temperature), true);
        setState(`${TEMP_PREFIX}.nozzleTarget`, round1(ex.target), true);
        setState(`${TEMP_PREFIX}.bedTemp`, round1(bed.temperature), true);
        setState(`${TEMP_PREFIX}.bedTarget`, round1(bed.target), true);

        setState(`${FANS_PREFIX}.partCooling`, pinToPercent(fan0.value), true);
        setState(`${FANS_PREFIX}.partCoolingRpm`, Number(fb.fan0_speed) || 0, true);
        setState(`${FANS_PREFIX}.hotend`, pinToPercent(hotendFan.speed), true);
        setState(`${FANS_PREFIX}.board`, pinToPercent(boardFan.value), true);
        setState(`${FANS_PREFIX}.aux`, pinToPercent(eFan.value), true);

        setState(`${PREFIX}.filamentSlot`, cfs.activeSlot, true);
        setState(`${PREFIX}.filamentMaterial`, cfs.activeMaterial, true);
        setState(`${PREFIX}.filamentColor`, cfs.activeColor, true);

        setState(`${CFS_PREFIX}.type`, cfs.type, true);
        setState(`${CFS_PREFIX}.state`, cfs.state, true);
        setState(`${CFS_PREFIX}.enable`, cfs.enable, true);
        setState(`${CFS_PREFIX}.temperature`, cfs.temperature, true);
        setState(`${CFS_PREFIX}.humidity`, cfs.humidity, true);

        for (const id of CFS_SLOTS) {
            const s = cfs.slots[id] || {
                color: '', material: '', occupied: false, active: false,
            };
            setState(`${CFS_PREFIX}.${id}.color`, s.color, true);
            setState(`${CFS_PREFIX}.${id}.material`, s.material, true);
            setState(`${CFS_PREFIX}.${id}.occupied`, s.occupied, true);
            setState(`${CFS_PREFIX}.${id}.active`, s.active, true);
        }
    } catch (e) {
        logMoonrakerUnreachable(e);
        // WS läuft oft weiter — Fortschritt aus Telemetrie; online nur wenn WS auch weg
        publishProgressFromCreality();
        publishUiState(null);
        if (!(crealityWs && crealityWs.readyState === 1)) {
            setState(`${PREFIX}.online`, false, true);
        }
    }
}

async function main() {
    log(`Creality-Skript startet → Moonraker :${PORT}, Creality-WS :${CREALITY_WS_PORT}`, 'info');
    crealityWsStopping = false;
    await ensureStates();
    bindControls();
    connectCrealityWs();
    await poll();

    if (timer) clearInterval(timer);
    timer = setInterval(() => {
        poll().catch((e) => logMoonrakerUnreachable(e));
    }, INTERVAL_MS);
}

onStop((callback) => {
    if (timer) clearInterval(timer);
    stopCrealityWs();
    callback();
}, 2000);

main().catch((e) => log(`Creality start fehlgeschlagen: ${e.message}`, 'error'));
