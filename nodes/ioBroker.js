/**
 * Copyright 2014-2025 bluefox <dogafox@gmail.com>.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

function delay(time) {
    return new Promise(resolve => setTimeout(resolve, time));
}

module.exports = function (RED) {
    'use strict';
    // patch event emitter
    require('events').EventEmitter.prototype._maxListeners = 10000;

    const utils = require('@iobroker/adapter-core');
    const settings = require(`${process.env.NODE_RED_HOME}/lib/red`).settings;

    const instance = settings.get('iobrokerInstance') || 0;
    let config = settings.get('iobrokerConfig');
    const valueConvert = settings.get('valueConvert');
    const allowCreationOfForeignObjects = settings.get('allowCreationOfForeignObjects');
    if (typeof config === 'string') {
        config = JSON.parse(config);
    }
    let adapter;
    const existingNodes = [];
    const stateChangeSubscribedNodes = [];

    try {
        adapter = utils.Adapter({ name: 'node-red', instance, config });
    } catch (e) {
        console.log(e);
    }
    if (typeof adapter.setMaxListeners === 'function') {
        adapter.setMaxListeners(10000);
    }
    const nodeSets = [];
    const checkStates = [];
    const verifiedObjects = {};
    const subscribedIds = {};
    const isValidIDRegExp = new RegExp('^[_A-Za-z0-9ÄÖÜäöüа-яА-Я][-_A-Za-z0-9ÄÖÜäöüа-яА-Я]+\\.\\d+\\.');
    let ready = false;
    const log = adapter && adapter.log && adapter.log.warn ? adapter.log.warn : console.log;

    adapter.on('ready', () => {
        function checkQueuedStates(callback) {
            if (!checkStates.length) {
                return callback && callback();
            }
            const check = checkStates.shift();
            //adapter.log.debug(`${check.node.id} Delayed check state ...`)
            checkState(check.node, check.id, check.common, check.val, () => {
                check.callback && check.callback();
                setTimeout(() => checkQueuedStates(callback), 20);
            });
        }

        ready = true;

        adapter.log.debug(`Ready event received ... start to check ${checkStates.length} Nodes`);

        checkQueuedStates(async () => {
            adapter.log.debug(`... delay-initialize ${existingNodes.length} Nodes`);
            for (const node of existingNodes) {
                if (node.isReady) {
                    continue;
                }
                node.status({ fill: 'green', shape: 'dot', text: 'connected' });
                //adapter.log.debug(`${node.id} Initialized (ready=was-false)`);
                if (node instanceof IOBrokerInNode) {
                    if (!stateChangeSubscribedNodes.includes(node.id)) {
                        //adapter.log.debug(`${node.id} Init stateChange listener`);
                        adapter.on('stateChange', node.stateChange);
                        stateChangeSubscribedNodes.push(node.id);

                        if (
                            !node.topic.includes('*') &&
                            (node.func === 'rbe-preinitvalue' ||
                                node.func === 'deadband-preinitvalue' ||
                                node.fireOnStart)
                        ) {
                            try {
                                const state = await adapter.getForeignStateAsync(node.topic);
                                if (node.func === 'rbe-preinitvalue' || node.func === 'deadband-preinitvalue') {
                                    const t = node.topic.replace(/\./g, '/') || '_no_topic';
                                    node.previous[t] = state ? state.val : null;
                                    //adapter.log.debug(`${node.id} Pre-Initialize Value ${JSON.stringify(node.previous[t])}`);
                                }
                                if (node.fireOnStart) {
                                    node.stateChange(node.topic, state);
                                    delay(20);
                                }
                            } catch (err) {
                                //adapter.log.info(`${node.id}: Could not read the value of "${node.topic}" for initialization: ${err.message}`);
                            }
                        }
                    }
                }
                if (node.subscribePattern) {
                    if (!subscribedIds[node.subscribePattern]) {
                        subscribedIds[node.subscribePattern] = 1;
                        await adapter.subscribeForeignStatesAsync(node.subscribePattern);
                    } else {
                        subscribedIds[node.subscribePattern]++;
                    }
                    //adapter.log.debug(`${node.id} Subscribe to "${node.subscribePattern}" (${subscribedIds[node.subscribePattern]})`);
                }
            }

            let count = 0;

            //adapter.log.debug(`... delay-set ${nodeSets.length} Node values`);
            while (nodeSets.length) {
                const nodeSetData = nodeSets.pop();
                nodeSetData.node.emit('input', nodeSetData.msg);
                count++;
            }
            if (count) {
                log(`${count} queued state values set in ioBroker`);
            }

            RED.httpAdmin.post('/iobroker/token', async function (req, res) {
                // Ask for the token by admin instance
                const admins = await adapter.getObjectViewAsync(
                    'system',
                    'instance',
                    { startkey: 'system.adapter.admin.', endkey: 'system.adapter.admin.\u9999' },
                    {},
                );
                const instanceObj = await adapter.getForeignObjectAsync(`system.adapter.${adapter.namespace}`);
                let admin = admins.rows.find(
                    obj =>
                        // admin should run on the same host
                        obj.value.common.host === instanceObj.common.host &&
                        // admin should be enabled
                        obj.value.common.enabled &&
                        // admin should have the secure option enabled if node-red has the secure option enabled and vice versa
                        !!obj.value.native.secure === !!instanceObj.native.secure,
                );

                const adminInstanceObj = admin?.value || null;
                if (adminInstanceObj) {
                    if (adminInstanceObj.native.auth) {
                        let timeout = setTimeout(() => {
                            timeout = null;
                            res.status(401).json({ error: 'No admin instance found' });
                        }, 500);
                        // Ask the admin instance for the token
                        adapter.sendTo(
                            adminInstanceObj._id,
                            'internalToken',
                            null,
                            response => {
                                if (timeout) {
                                    clearTimeout(timeout);
                                    timeout = null;
                                    if (!response || response.error) {
                                        res.status(401).json({ error: response?.error || 'No answer' });
                                    } else {
                                        res.json(response);
                                    }
                                }
                            },
                        );
                    } else {
                        res.json({ access_token: 'not required' });
                    }
                } else {
                    res.status(401).json({ error: 'No admin instance found' });
                }
            });
        });
    });

    function isValidId(id) {
        return isValidIDRegExp.test(id) || id.startsWith('system.');
    }

    function isForeignState(id) {
        return isValidId(id) && !id.startsWith(`${adapter.namespace}.`);
    }

    // name is like system.state, pattern is like "*.state" or "*" or "*system*"
    function getRegex(pattern) {
        if (!pattern || pattern === '*') {
            return null;
        }
        if (!pattern.includes('*')) {
            return null;
        }
        if (pattern[pattern.length - 1] !== '*') {
            pattern = `${pattern}$`;
        }
        if (pattern[0] !== '*') {
            pattern = `^${pattern}`;
        }
        pattern = pattern.replace(/\./g, '\\.');
        pattern = pattern.replace(/\*/g, '.*');
        return new RegExp(pattern);
    }

    function validIdForAutomaticFolderCreation(id) {
        return id.startsWith('javascript.') || id.startsWith('0_userdata.0.') || id.startsWith('node-red.');
    }

    async function ensureObjectStructure(id) {
        //adapter.log.debug(`ensure Logic called for "${id}": ${verifiedObjects[id]}`);
        if (!validIdForAutomaticFolderCreation(id)) {
            return;
        }
        if (verifiedObjects[id] === true) {
            return;
        }
        const idArr = id.split('.');
        idArr.pop(); // the last is created as object in any way
        if (idArr.length < 3) {
            return; // Nothing to do
        }
        // We just create sub level projects
        let idToCheck = idArr.splice(0, 2).join('.');

        verifiedObjects[id] = true;
        for (const part of idArr) {
            idToCheck += `.${part}`;
            //adapter.log.debug(`    check "${idToCheck}": ${verifiedObjects[idToCheck]}`);
            if (verifiedObjects[idToCheck] === true) {
                continue;
            }
            verifiedObjects[idToCheck] = true;
            let obj;
            try {
                obj = await adapter.getForeignObjectAsync(idToCheck);
            } catch (err) {
                // ignore
            }
            if (!obj || !obj.common) {
                //adapter.log.debug(`Create folder object for ${idToCheck}`);
                try {
                    await adapter.setForeignObjectAsync(idToCheck, {
                        type: 'folder',
                        common: {
                            name: part,
                        },
                        native: {
                            autocreated: 'by automatic ensure logic',
                        },
                    });
                } catch (err) {
                    adapter.log.info(`Could not automatically create folder object ${idToCheck}: ${err.message}`);
                }
            } else {
                //adapter.log.debug(`    already existing "${idToCheck}": ${JSON.stringify(obj)}`);
            }
        }
    }

    // check if an object exists and sets its value if provided
    function checkState(node, id, common, val, callback) {
        if (node.idChecked) {
            return callback && callback();
        }
        if (!ready) {
            return checkStates.push({ node, id, common, val, callback });
        }

        if (node.topic) {
            node.idChecked = true;
        }

        if (
            val === null ||
            val === '__create__' ||
            (typeof val === 'object' && (val.val === '__create__' || val.val === null))
        ) {
            val = undefined;
        }

        adapter.getObject(id, async (err, obj) => {
            if (
                obj?._id &&
                validIdForAutomaticFolderCreation(obj._id) &&
                obj.type === 'folder' &&
                obj.native &&
                obj.native.autocreated === 'by automatic ensure logic'
            ) {
                // ignore default created object because we now have a more defined one
                obj = null;
            }
            if (!obj) {
                adapter.getForeignObject(id, async (err, obj) => {
                    if (
                        obj?._id &&
                        validIdForAutomaticFolderCreation(obj._id) &&
                        obj.type === 'folder' &&
                        obj.native &&
                        obj.native.autocreated === 'by automatic ensure logic'
                    ) {
                        // ignore default created object because we now have a more defined one
                        obj = null;
                    }
                    // If not exists
                    if (!obj) {
                        if (common) {
                            log(`${node.id}: State "${id}" was created in ioBroker`);
                            // Create object
                            const data = {
                                common,
                                native: {},
                                type: 'state',
                            };

                            if (isForeignState(id)) {
                                if (allowCreationOfForeignObjects) {
                                    adapter.setForeignObject(id, data, async () => {
                                        await ensureObjectStructure(id);
                                        if (val !== undefined) {
                                            await adapter.setForeignStateAsync(id, val);
                                        }
                                        callback && callback(true);
                                    });
                                } else {
                                    adapter.log.info(
                                        `${node.id}: "${node.customName}" Cannot set state of non-existing object "${id}".`,
                                    );
                                    adapter.log.info(
                                        `${node.id}: Creation of foreign objects is not enabled. You can enable it in the instance configuration`,
                                    );
                                    callback && callback(false);
                                }
                            } else {
                                adapter.setObject(id, data, async () => {
                                    await ensureObjectStructure(`${adapter.namespace}.${id}`);
                                    if (val !== undefined) {
                                        await adapter.setStateAsync(id, val);
                                    }
                                    callback && callback(true);
                                });
                            }
                        } else {
                            adapter.log.info(
                                `${node.id}: "${node.customName}" Cannot set state of non-existing object "${id}".`,
                            );
                            adapter.log.info(
                                `${node.id}: Automatic objects creation is not enabled. You can enable it in the node configuration`,
                            );
                            callback && callback(false);
                        }
                    } else {
                        node._id = obj._id;
                        await ensureObjectStructure(obj._id);
                        if (val !== undefined) {
                            await adapter.setForeignStateAsync(obj._id, val);
                        }
                        callback && callback(true);
                    }
                });
            } else {
                await ensureObjectStructure(obj._id);
                if (val !== undefined) {
                    await adapter.setForeignStateAsync(obj._id, val);
                }
                callback && callback(true);
            }
        });
    }

    function assembleCommon(node, msg, id) {
        msg = msg || {};
        const common = {
            read: true,
            write: node.objectPreDefinedReadonly,
            desc: 'Created by Node-Red',
            role: node.objectPreDefinedRole || msg.stateRole || 'state',
            name: node.objectPreDefinedName || msg.stateName || id,
            type: node.objectPreDefinedType || msg.stateType || typeof msg.payload || 'string',
        };
        if (msg.stateReadonly !== undefined) {
            common.write = msg.stateReadonly === false || msg.stateReadonly === 'false';
        }

        if (node.objectPreDefinedUnit || msg.stateUnit) {
            common.unit = node.objectPreDefinedUnit || msg.stateUnit;
        }
        if (node.objectPreDefinedMax || node.objectPreDefinedMax === 0 || msg.stateMax || msg.stateMax === 0) {
            if (node.objectPreDefinedMax || node.objectPreDefinedMax === 0) {
                common.max = node.objectPreDefinedMax;
            } else {
                common.max = msg.stateMax;
            }
        }
        if (node.objectPreDefinedMin || node.objectPreDefinedMin === 0 || msg.stateMin || msg.stateMin === 0) {
            if (node.objectPreDefinedMin || node.objectPreDefinedMin === 0) {
                common.min = node.objectPreDefinedMin;
            } else {
                common.min = msg.stateMin;
            }
        }
        return common;
    }

    function defineCommon(node, n) {
        node.autoCreate = n.autoCreate === 'true' || n.autoCreate === true;

        if (node.autoCreate) {
            node.objectPreDefinedRole = n.role;
            node.objectPreDefinedType = n.payloadType;
            node.objectPreDefinedName = n.stateName || '';
            node.objectPreDefinedReadonly = n.readonly === 'false' || n.readonly === false;
            node.objectPreDefinedUnit = n.stateUnit;
            node.objectPreDefinedMin = n.stateMin;
            node.objectPreDefinedMax = n.stateMax;
        }
    }

    async function onClose(node, done) {
        const pos = existingNodes.indexOf(node);
        if (pos !== -1) {
            existingNodes.splice(pos, 1);
        }
        done();
    }

    function IOBrokerInNode(n) {
        const node = this;
        RED.nodes.createNode(node, n);
        node.topic = (n.topic || '*').replace(/\//g, '.');
        node.customName = 'ioBroker in';

        defineCommon(node, n);

        // If no adapter prefix, add own adapter prefix
        if (node.topic && !isValidId(node.topic) && !node.topic.startsWith(adapter.namespace)) {
            node.topic = `${adapter.namespace}.${node.topic}`;
        }
        node.subscribePattern = node.topic;

        node.regexTopic = getRegex(node.topic);
        node.payloadType = n.payloadType;
        node.onlyack = n.onlyack === true || n.onlyack === 'true' || false;
        node.func = n.func || 'all';
        node.gap = n.gap || '0';
        node.fireOnStart = n.fireOnStart === true || n.fireOnStart === 'true' || false;
        node.outFormat = n.outFormat || 'MQTT';
        node.attrname = n.attrname || 'payload';

        if (n.onlyack === 'update') {
            node.onlyack = true;
        } else if (n.onlyack === 'command') {
            node.onlyack = false;
        } else if (n.onlyack === '') {
            node.onlyack = null;
        }

        if (node.gap.substr(-1) === '%') {
            node.pc = true;
            node.gap = parseFloat(node.gap);
        }
        node.g = node.gap;

        node.previous = {};

        // Create ID if not exits
        if (node.topic && !node.topic.includes('*')) {
            checkState(node, node.topic);
        }

        if (ready) {
            node.status({ fill: 'green', shape: 'dot', text: 'connected' });
        } else {
            node.status({ fill: 'red', shape: 'ring', text: 'disconnected' }, true);
        }

        node.stateChange = function (topic, state) {
            if (node.regexTopic) {
                if (!node.regexTopic.test(topic)) {
                    return;
                }
            } else if (node.topic !== '*' && node.topic !== topic) {
                return;
            }
            //adapter.log.debug(`${node.id} Got stateChanged trigger for ${topic} with ${JSON.stringify(state)}`);

            if (node.onlyack && state && !state.ack) {
                return;
            } else if (node.onlyack === false && state && state.ack) {
                return;
            }

            try {
                const t = topic.replace(/\./g, '/') || '_no_topic';
                //node.log ("Function: " + node.func);

                if (node.func === 'rbe' || node.func === 'rbe-preinitvalue') {
                    //node.log(`${node.id} RBE check ${JSON.stringify(state && state.val)} vs. ${JSON.stringify(node.previous[t])}: send value: ${!(state && state.val === node.previous[t])}`);
                    if (state && state.val === node.previous[t]) {
                        return;
                    }
                } else if (state && (node.func === 'deadband' || node.func === 'deadband-preinitvalue')) {
                    const n = parseFloat(state.val.toString());
                    if (!isNaN(n)) {
                        //node.log('Old Value: ' + node.previous[t] + ' New Value: ' + n);
                        if (node.pc) {
                            node.gap = (node.previous[t] * node.g) / 100 || 0;
                        }
                        if (!Object.prototype.hasOwnProperty.call(node.previous, t)) {
                            node.previous[t] = n - node.gap;
                        }
                        //node.log(`${node.id} Deadband check ${n} vs. ${node.previous[t]} with gap ${node.gap}: Send value ${Math.abs(n - node.previous[t]) >= node.gap}`);
                        if (Math.abs(n - node.previous[t]) < node.gap) {
                            return;
                        }
                    } else {
                        node.warn(`${node.id}: Ignore deadband filter because no number found in value ${state.val}`);
                        return;
                    }
                }
                node.previous[t] = state ? state.val : null;

                //adapter.log.debug(`${node.id} Node.send payload: ${(node.payloadType === 'object' ? state : (!state || state.val === null || state.val === undefined ? '' : (valueConvert ? state.val.toString() : state.val)))}`);
                node.send({
                    topic: node.outFormat === 'ioBroker' ? t.replace(/\//g, '.') : t,
                    [node.attrname]:
                        node.payloadType === 'object'
                            ? state
                            : !state || state.val === null || state.val === undefined
                              ? ''
                              : valueConvert
                                ? state.val.toString()
                                : state.val,
                    acknowledged: state ? state.ack : false,
                    timestamp: state ? state.ts : Date.now(),
                    lastchange: state ? state.lc : Date.now(),
                    from: state ? state.from : '',
                });

                if (!state) {
                    node.status({
                        fill: 'red',
                        shape: 'ring',
                        text: 'not exists',
                    });
                } else {
                    node.status({
                        fill: 'green',
                        shape: 'dot',
                        text:
                            node.payloadType === 'object'
                                ? JSON.stringify(state)
                                : !state || state.val === null || state.val === undefined
                                  ? ''
                                  : state.val.toString(),
                    });
                }
            } catch (err) {
                adapter.log.error(`${node.id} ERROR Statechange: ${err.message} : ${err.stack}`);
            }
        };

        if (ready) {
            node.isReady = true;
            //adapter.log.debug(`${node.id} Initialized (ready=${ready})`);

            if (!stateChangeSubscribedNodes.includes(node.id)) {
                adapter.on('stateChange', node.stateChange);
                stateChangeSubscribedNodes.push(node.id);
                //adapter.log.debug(`${node.id} Init stateChange listener`);
            }
            if (node.subscribePattern) {
                if (!subscribedIds[node.subscribePattern]) {
                    subscribedIds[node.subscribePattern] = 1;
                    adapter.subscribeForeignStates(node.subscribePattern);
                } else {
                    subscribedIds[node.subscribePattern]++;
                }
                //adapter.log.debug(`${node.id} Subscribe to "${node.subscribePattern}" (${subscribedIds[node.subscribePattern]})`);
            }

            if (
                !node.topic.includes('*') &&
                (node.func === 'rbe-preinitvalue' || node.func === 'deadband-preinitvalue' || node.fireOnStart)
            ) {
                adapter.getForeignState(node.topic, (err, state) => {
                    err &&
                        adapter.log.info(
                            `${node.id}: Could not read value of "${node.topic}" for initialization: ${err.message}`,
                        );
                    if (node.func === 'rbe-preinitvalue' || node.func === 'deadband-preinitvalue') {
                        const t = node.topic.replace(/\./g, '/') || '_no_topic';
                        node.previous[t] = state ? state.val : null;
                        //adapter.log.debug(`${node.id} Pre-Initialize Value ${JSON.stringify(node.previous[t])}`);
                    }
                    if (node.fireOnStart) {
                        node.stateChange(node.topic, state);
                    }
                });
            }
        }

        node.on('close', async done => {
            //adapter.log.debug(`${node.id} Close node (with pattern "${node.subscribePattern}")`)
            if (node.subscribePattern && !--subscribedIds[node.subscribePattern]) {
                //adapter.log.debug(`${node.id} Unsubscribe for "${node.subscribePattern}" (${subscribedIds[node.subscribePattern]})`);
                try {
                    await adapter.unsubscribeForeignStates(node.subscribePattern);
                } catch {
                    // ignore
                }
            }
            adapter.removeListener('stateChange', node.stateChange);
            const index = stateChangeSubscribedNodes.indexOf(node.id);
            //adapter.log.debug(`${node.id} Remove stateChange listener (${index})`);
            if (index !== -1) {
                stateChangeSubscribedNodes.splice(index, 1);
            }
            await onClose(node, done);
        });
        existingNodes.push(node);
    }
    RED.nodes.registerType('ioBroker in', IOBrokerInNode);

    function IOBrokerOutNode(n) {
        const node = this;
        RED.nodes.createNode(node, n);
        node.topic = n.topic;
        node.customName = 'ioBroker out';

        node.ack = n.ack === 'true' || n.ack === true;

        defineCommon(node, n);

        if (ready) {
            node.isReady = true;
            node.status({ fill: 'green', shape: 'dot', text: 'connected' });
        } else {
            node.status({ fill: 'red', shape: 'ring', text: 'disconnected' }, true);
        }

        function setState(id, val, ack, callback) {
            if (node.idChecked) {
                if (val !== undefined && val !== '__create__') {
                    // If not this adapter state
                    if (isForeignState(id)) {
                        adapter.setForeignState(id, { val, ack }, callback);
                    } else {
                        adapter.setState(id, { val, ack }, callback);
                    }
                }
            } else {
                checkState(node, id, null, { val, ack }, isOk => callback && callback(!isOk));
            }
        }

        node.on('input', (msg, send, done) => {
            let id = node.topic;
            if (!id) {
                id = msg.topic;
            }
            if (id) {
                id = id.replace(/\//g, '.');
            }
            // if not starts with adapter.instance.
            if (id && !isValidId(id) && !id.startsWith(adapter.namespace)) {
                id = `${adapter.namespace}.${id}`;
            }

            const msgAck = msg.ack !== undefined ? msg.ack === 'true' || msg.ack === true : node.ack;

            if (!ready) {
                //log('Message for "' + id + '" queued because ioBroker connection not initialized');
                nodeSets.push({ node, msg });
            } else if (id) {
                // Create variable if not exists
                if (node.autoCreate && !node.idChecked) {
                    if (!id.includes('*') && isValidId(id)) {
                        return checkState(
                            node,
                            id,
                            assembleCommon(node, msg, id),
                            { val: msg.payload, ack: msgAck },
                            isOk => {
                                if (isOk) {
                                    node.status({
                                        fill: 'green',
                                        shape: 'dot',
                                        text:
                                            msg.payload === null || msg.payload === undefined
                                                ? ''
                                                : msg.payload === '__create__'
                                                  ? 'Object created'
                                                  : msg.payload.toString(),
                                    });
                                } else {
                                    node.status({
                                        fill: 'red',
                                        shape: 'ring',
                                        text: 'Cannot set state',
                                    });
                                }
                                done();
                            },
                        );
                    }
                }
                // If not this adapter state
                if (isForeignState(id)) {
                    // Check if state exists
                    adapter.getForeignObject(id, (err, obj) => {
                        if (!err && obj) {
                            adapter.setForeignState(id, { val: msg.payload, ack: msgAck }, (err, _id) => {
                                if (err) {
                                    node.status({
                                        fill: 'red',
                                        shape: 'ring',
                                        text: 'Error on setForeignState. See Log',
                                    });
                                    log(`${node.id}: Error on setState for ${id}: ${err}`);
                                } else {
                                    node.status({
                                        fill: 'green',
                                        shape: 'dot',
                                        text: `${_id}: ${msg.payload === null || msg.payload === undefined ? '' : msg.payload.toString()}`,
                                    });
                                }
                                done();
                            });
                        } else {
                            log(`${node.id}: State "${id}" does not exist in ioBroker`);
                            node.status({
                                fill: 'red',
                                shape: 'ring',
                                text: `State "${id}" does not exist in ioBroker`,
                            });
                            done();
                        }
                    });
                } else {
                    if (id.includes('*')) {
                        log(`${node.id}: Invalid topic name "${id}" for ioBroker`);
                        node.status({
                            fill: 'red',
                            shape: 'ring',
                            text: `Invalid topic name "${id}" for ioBroker`,
                        });
                        done();
                    } else {
                        setState(id, msg.payload, msgAck, (err, _id) => {
                            if (err) {
                                node.status({
                                    fill: 'red',
                                    shape: 'ring',
                                    text: 'Error on setState. See Log',
                                });
                                log(`${node.id}: Error on setState for ${id}: ${err}`);
                            } else {
                                node.status({
                                    fill: 'green',
                                    shape: 'dot',
                                    text: `${_id}: ${msg.payload === null || msg.payload === undefined ? '' : msg.payload.toString()}`,
                                });
                            }
                            done();
                        });
                    }
                }
            } else {
                node.warn('No key or topic set');
                node.status({
                    fill: 'red',
                    shape: 'ring',
                    text: 'No key or topic set',
                });
                done();
            }
        });

        node.on('close', done => onClose(node, done));
        existingNodes.push(node);
    }
    RED.nodes.registerType('ioBroker out', IOBrokerOutNode);

    function IOBrokerGetNode(n) {
        const node = this;
        RED.nodes.createNode(node, n);
        node.topic = typeof n.topic === 'string' && n.topic.length > 0 ? n.topic.replace(/\//g, '.') : null;
        node.customName = 'ioBroker get';

        defineCommon(node, n);

        // If no adapter prefix, add own adapter prefix
        if (node.topic && !isValidId(node.topic) && !node.topic.startsWith(adapter.namespace)) {
            node.topic = `${adapter.namespace}.${node.topic}`;
        }

        node.errOnInvalidState = n.errOnInvalidState;
        node.payloadType = n.payloadType;
        node.attrname = n.attrname;

        // Create ID if not exits
        if (node.topic && !node.topic.includes('*')) {
            checkState(node, node.topic);
        }

        if (ready) {
            node.isReady = true;
            node.status({ fill: 'green', shape: 'dot', text: 'connected' });
        } else {
            node.status({ fill: 'red', shape: 'ring', text: 'disconnected' }, true);
        }

        node.getStateValue = function (msg, id) {
            return function (err, state) {
                if (!err && state) {
                    msg[node.attrname] =
                        node.payloadType === 'object'
                            ? state
                            : state.val === null || state.val === undefined
                              ? ''
                              : valueConvert
                                ? state.val.toString()
                                : state.val;
                    msg.acknowledged = state.ack;
                    msg.timestamp = state.ts;
                    msg.lastchange = state.lc;
                    msg.topic = node.topic || msg.topic;
                    node.status({
                        fill: 'green',
                        shape: 'dot',
                        text:
                            node.payloadType === 'object'
                                ? JSON.stringify(state)
                                : state.val === null || state.val === undefined
                                  ? ''
                                  : state.val.toString(),
                    });
                    node.send(msg);
                } else {
                    const getObjFunc = isForeignState(id)
                        ? adapter.getForeignObject.bind(adapter)
                        : adapter.getObject.bind(adapter);
                    getObjFunc(id, (err, obj) => {
                        if ((err || !obj) && (node.errOnInvalidState === 'true' || node.errOnInvalidState === true)) {
                            node.error(`Object for state ${id} do not exist`, msg);
                            return;
                        }

                        msg[node.attrname] = node.payloadType === 'object' ? state : valueConvert ? '' : undefined;
                        msg.topic = node.topic || msg.topic;
                        node.status({
                            fill: 'yellow',
                            shape: 'dot',
                            text: node.payloadType === 'object' ? JSON.stringify(state) : '',
                        });
                        if (
                            node.errOnInvalidState !== 'true' &&
                            node.errOnInvalidState !== true &&
                            node.errOnInvalidState !== 'false' &&
                            node.errOnInvalidState !== false
                        ) {
                            if (err || !obj) {
                                log(
                                    `${node.id}: Object for state ${id} do not exist: ${err ? err.message : 'unknown'}`,
                                );
                            } else if (!state) {
                                log(`${node.id}: State ${id} has no value`);
                            }
                        } else {
                            node.send(msg);
                        }
                    });
                }
            };
        };

        node.on('input', msg => {
            let id = node.topic || msg.topic;
            if (!ready) {
                nodeSets.push({ node, msg });
                //log('Message for "' + id + '" queued because ioBroker connection not initialized');
                return;
            }
            if (id) {
                if (id.includes('*')) {
                    log(`${node.id}: Invalid topic name "${id}" for ioBroker`);
                } else {
                    id = id.replace(/\//g, '.');
                    // If not this adapter state
                    if (isForeignState(id)) {
                        return adapter.getForeignState(id, node.getStateValue(msg, id));
                    } else {
                        return adapter.getState(id, node.getStateValue(msg, id));
                    }
                }
            } else {
                node.warn('No key or topic set');
            }
        });

        node.on('close', done => onClose(node, done));
        existingNodes.push(node);
    }
    RED.nodes.registerType('ioBroker get', IOBrokerGetNode);

    function IOBrokerGetObjectNode(n) {
        const node = this;
        RED.nodes.createNode(node, n);
        node.topic = typeof n.topic === 'string' && n.topic.length > 0 ? n.topic.replace(/\//g, '.') : null;
        node.customName = 'ioBroker get object';

        defineCommon(node, n);

        // If no adapter prefix, add own adapter prefix
        if (node.topic && !isValidId(node.topic) && !node.topic.startsWith(adapter.namespace)) {
            node.topic = `${adapter.namespace}.${node.topic}`;
        }
        node.attrname = n.attrname;

        // Create ID if not exits
        if (node.topic && !node.topic.includes('*')) {
            checkState(node, node.topic);
        }

        if (ready) {
            node.isReady = true;
            node.status({ fill: 'green', shape: 'dot', text: 'connected' });
        } else {
            node.status({ fill: 'red', shape: 'ring', text: 'disconnected' }, true);
        }

        node.getObject = function (msg) {
            return function (err, state) {
                if (!err && state) {
                    msg[node.attrname] = state;
                    msg.topic = node.topic || msg.topic;
                    node.status({
                        fill: 'green',
                        shape: 'dot',
                        text: JSON.stringify(state),
                    });
                    node.send(msg);
                } else {
                    log(`${node.id}: Object "${node.topic || msg.topic}" does not exist in ioBroker`);
                }
            };
        };

        node.on('input', msg => {
            let id = node.topic || msg.topic;
            if (!ready) {
                nodeSets.push({ node, msg });
                //log('Message for "' + id + '" queued because ioBroker connection not initialized');
            } else if (id) {
                if (id.includes('*')) {
                    log(`${node.id}: Invalid topic name "${id}" for ioBroker`);
                } else {
                    id = id.replace(/\//g, '.');
                    // If not this adapter state
                    if (isForeignState(id)) {
                        // Check if state exists
                        return adapter.getForeignObject(id, node.getObject(msg));
                    } else {
                        return adapter.getObject(id, node.getObject(msg));
                    }
                }
            } else {
                node.warn('No key or topic set');
            }
        });

        node.on('close', done => onClose(node, done));
        existingNodes.push(node);
    }
    RED.nodes.registerType('ioBroker get object', IOBrokerGetObjectNode);

    function IOBrokerListNode(n) {
        const node = this;
        RED.nodes.createNode(node, n);
        node.topic = typeof n.topic === 'string' && n.topic.length > 0 ? n.topic.replace(/\//g, '.') : null;
        node.customName = 'ioBroker list';

        // If no adapter prefix, add own adapter prefix
        if (node.topic && !isValidId(node.topic) && !node.topic.startsWith(adapter.namespace)) {
            node.topic = `${adapter.namespace}.${node.topic}`;
        }
        node.objType = n.objType;
        node.regex = n.regex;
        node.asArray = n.asArray === 'true' || n.asArray === true;
        node.onlyIDs = n.onlyIDs === 'true' || n.onlyIDs === true;
        node.withValues = n.withValues === 'true' || n.withValues === true;
        if (node.regex) {
            node.regex = new RegExp(node.regex);
        }

        if (ready) {
            node.isReady = true;
            node.status({ fill: 'green', shape: 'dot', text: 'connected' });
        } else {
            node.status({ fill: 'red', shape: 'ring', text: 'disconnected' }, true);
        }

        node.getObject = function (msg) {
            return function (err, state) {
                if (!err && state) {
                    msg[node.attrname] = state;
                    node.status({
                        fill: 'green',
                        shape: 'dot',
                        text: JSON.stringify(state),
                    });
                    node.send(msg);
                } else {
                    log(`${node.id}: Object "${node.topic || msg.topic}" does not exist in ioBroker`);
                }
            };
        };

        node.on('input', async msg => {
            let pattern = node.topic || msg.topic;
            if (!ready) {
                nodeSets.push({ node, msg });
            } else if (pattern) {
                pattern = pattern.replace(/\//g, '.');

                let regex = node.regex;
                if (msg.regex && (typeof msg.regex === 'string' || msg.regex instanceof RegExp)) {
                    if (typeof msg.regex === 'string') {
                        try {
                            regex = new RegExp(msg.regex);
                        } catch (e) {
                            log(`${node.id}: Cannot create regular expression from "${msg.regex}"!`);
                        }
                    } else {
                        regex = msg.regex;
                    }
                }

                let list = {};
                // Adds result rows to the return object
                /** @param {any[] | undefined} rows */
                const addRows = rows => {
                    if (rows) {
                        for (const id in rows) {
                            list[id] = rows[id];
                        }
                    }
                };

                try {
                    if (!node.objType || node.objType === 'folder') {
                        const folders = await adapter.getForeignObjectsAsync(pattern, 'folder');
                        addRows(folders);
                    }
                } catch (err) {
                    /* ignore, we'll return what we get till now */
                    log(`${node.id}: Error while requesting folders: ${err}`);
                }
                try {
                    if (!node.objType || node.objType === 'device') {
                        const devices = await adapter.getForeignObjectsAsync(pattern, 'device');
                        addRows(devices);
                    }
                } catch (err) {
                    /* ignore, we'll return what we get till now */
                    log(`${node.id}: Error while requesting devices: ${err}`);
                }
                try {
                    if (!node.objType || node.objType === 'channel') {
                        const channels = await adapter.getForeignObjectsAsync(pattern, 'channel');
                        addRows(channels);
                    }
                } catch (err) {
                    /* ignore, we'll return what we get till now */
                    log(`${node.id}: Error while requesting channels: ${err}`);
                }
                try {
                    if (!node.objType || node.objType === 'state') {
                        const states = await adapter.getForeignObjectsAsync(pattern, 'state');
                        addRows(states);
                    }
                } catch (err) {
                    /* ignore, we'll return what we get till now */
                    log(`${node.id}: Error while requesting states: ${err}`);
                }
                try {
                    if (!node.objType || node.objType === 'meta') {
                        const metas = await adapter.getForeignObjectsAsync(pattern, 'meta');
                        addRows(metas);
                    }
                } catch (err) {
                    /* ignore, we'll return what we get till now */
                    log(`Error while requesting metas: ${err}`);
                }
                try {
                    if (!node.objType || node.objType === 'instance') {
                        const instances = await adapter.getForeignObjectsAsync(pattern, 'instance');
                        addRows(instances);
                    }
                } catch (err) {
                    /* ignore, we'll return what we get till now */
                    log(`${node.id}: Error while requesting instances: ${err}`);
                }
                try {
                    if (!node.objType || node.objType === 'adapter') {
                        const adapters = await adapter.getForeignObjectsAsync(pattern, 'adapter');
                        addRows(adapters);
                    }
                } catch (err) {
                    /* ignore, we'll return what we get till now */
                    log(`${node.id}: Error while requesting adapters: ${err}`);
                }

                if (regex) {
                    adapter.log.debug(`${node.id}: process list using regex ${regex.toString()}`);
                    const newList = {};
                    Object.keys(list).forEach(id => {
                        if (regex.test(id)) {
                            newList[id] = list[id];
                        }
                    });
                    list = newList;
                }

                const ids = Object.keys(list);

                return adapter.getForeignStatesAsync(!node.withValues ? [] : ids).then(values => {
                    if (node.asArray) {
                        if (node.onlyIDs) {
                            msg.payload = ids;
                            if (node.withValues) {
                                msg.payload = msg.payload.map(id => {
                                    values[id] = values[id] || {};
                                    values[id]._id = id;
                                    return values[id];
                                });
                            }
                        } else {
                            const newList = [];
                            ids.forEach(id => newList.push(list[id]));
                            // Add states values if required
                            node.withValues && newList.forEach(el => Object.assign(el, values[el._id] || {}));
                            msg.payload = newList;
                        }
                        node.send(msg);
                    } else {
                        // every ID as one message
                        const _msg = JSON.parse(JSON.stringify(msg));
                        ids.forEach((id, i) => {
                            const __msg = !i ? msg : JSON.parse(JSON.stringify(_msg));
                            __msg.topic = id;
                            if (!node.onlyIDs) {
                                __msg.payload = list[id];
                            }
                            // Add states values if required
                            if (node.withValues) {
                                if (typeof __msg.payload !== 'object' || __msg.payload === null) {
                                    __msg.payload = {};
                                }
                                Object.assign(__msg.payload, values[id]);
                            }
                            node.send(__msg);
                        });
                    }
                });
            } else {
                node.warn('No pattern set');
            }
        });

        node.on('close', done => onClose(node, done));
        existingNodes.push(node);
    }
    RED.nodes.registerType('ioBroker list', IOBrokerListNode);

    function IOBrokerSendtoNode(n) {
        const node = this;
        RED.nodes.createNode(node, n);
        node.topic = typeof n.topic === 'string' && n.topic.length > 0 ? n.topic.replace(/\//g, '.') : null;
        node.customName = 'ioBroker sendTo';

        node.instance = n.instance;
        node.command = n.command || 'send';
        node.timeout = n.timeout || 1000;

        if (ready) {
            node.isReady = true;
            node.status({ fill: 'green', shape: 'dot', text: 'connected' });
        } else {
            node.status({ fill: 'red', shape: 'ring', text: 'disconnected' }, true);
        }

        node.on('input', (msg, send, done) => {
            if (!ready) {
                nodeSets.push({ node, msg });
                done();
            } else {
                const instance = msg.instance || node.instance;
                const command = msg.command || node.command;
                const timeout = parseInt(msg.timeout || node.timeout);

                adapter.sendTo(
                    instance,
                    command,
                    msg.payload,
                    data => {
                        if (data?.error) {
                            done(data.error);
                        } else if (data?.result) {
                            msg.payload = data.result;
                            send(msg);
                            done();
                        }
                    },
                    { timeout },
                );
            }
        });

        node.on('close', done => onClose(node, done));
        existingNodes.push(node);
    }
    RED.nodes.registerType('ioBroker sendTo', IOBrokerSendtoNode);
};
