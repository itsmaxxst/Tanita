'use strict';

const { SerialPort } = require('serialport');
const { DelimiterParser } = require('@serialport/parser-delimiter');

// -----------------------------------------------------------------------------
// Errors definition
// -----------------------------------------------------------------------------

const E_TempJson            = 1;
const E_NoDeviceFound       = 2;
const E_GenericOnDevice     = 3;
const E_CKError             = 4;
const E_GenericOnPlugin     = 5;
const E_Timeout             = 6;
const E_NoData              = 7;
const E_NoStep              = 206;
const E_Communication       = 210;
const E_Measurement         = 220;
const E_Platform            = 230;
const E_PlatformNotDetected = 240;
const E_DataSent            = 250;

let arrayMap = [
  [E_TempJson,            "Error on temp.json file"],
  [E_NoDeviceFound,       "No device Found"],
  [E_GenericOnDevice,     "Generic Error on device"],
  [E_CKError,             "CK Error"],
  [E_GenericOnPlugin,     "Generic Error on plugin"],
  [E_Timeout,             "Timeout, check if the device is connected and retry"],
  [E_NoData,              "No data or invalid data"],
  [E_NoStep,              "Timeout. Nobody Step-On on the platform"],
  [E_Communication,       "Communication errror. Disconnect and reconnect the USB cable of the footrest"],
  [E_Measurement,         "Measurement Error, restart the procedure"],
  [E_Platform,            "Error on the platform. Verify that is on ON and try again"],
  [E_PlatformNotDetected, "Platform not detected / connected. Check the footrest connection an try again"],
  [E_DataSent,            "An error was detected in the data sent. Enter the data correctly an try again"]
];

// -----------------------------------------------------------------------------
// Machine's states definition
// -----------------------------------------------------------------------------

const STATES = {
  INIT: "S0",
  PREPARE_SETUP: "S1",
  SETUP_COMPLETED: "S2",
  DETECT_NON_CONTACT: "SC",
  SETTING_ZERO_POINT: "S3",
  MEASURING_WEIGHT: "S4",
  MEASURING_BI: "S6",
  DETECT_CONTACT: "SD",
  MEASURING_50KHZ: "S8",
  MEASURING_6_25KHZ: "S8",
  OUTPUTTING_DATA: "SB",
  DETECTING_STEP_OFF: "S7",
  INTERNAL_ERROR: "E0",
  OVERLOAD_ERROR: "E1",
  IMPEDANCE_ERROR: "E2",
  ZERO_POINT_ERROR: "E3",
  MEASURE_WITHOUT_DATA_ERROR: "E4",
  NO_ZERO_POINT_ERROR: "E5",
  DATA_SET_PARAM_ERROR: "E6",
  FAT_PERC_ERROR: "E7",
  PARAMETER_FORMAT_ERROR: "EA",
  RECOVERY_STATE_ERROR: "EB",
  COMPLETED_SET_ZERO_POINT: "z1",
};

// -----------------------------------------------------------------------------
// Machine's commands definition
// -----------------------------------------------------------------------------

const COMMANDS = {
  CHECK_STATUS: "S?",
  PC_TO_NOPC: "M0",
  NOPC_TO_PC: "M1",
  CHECK_VERSION: "W?",
  CHECK_SPECS: "s?",
  INPUT_TARE: "D0",
  INPUT_GENDER: "D1",
  INPUT_BODY_TYPE: "D2",
  INPUT_HEIGHT: "D3",
  INPUT_AGE: "D4",
  INPUT_ID: "D5",
  INPUT_TARGET_FAT: "D6",
  CHECK_INFO_INPUT: "D?",
  MEASURE_BODY_COMPOSITION: "G0",
  MEASURE_WEIGHT: "F0",
  MEASURE_IMPEDANCE_50KHZ: "F5",
  MEASURE_IMPEDANCE_6_25KHZ: "F6",
  CALCULATION_AND_OUTPUT: "FC",
  CHECK_STEP_OFF: "F2",
  RESET: "Q",
  STANDBY: "q",
};

let message;

// -----------------------------------------------------------------------------
// TanitaDC13C class
// -----------------------------------------------------------------------------

class TanitaDC13C {
  constructor(portPath, baudRate = 9600, timeoutStepOn = 10000, timeout = 150000, polling = 500, logger, emitMessage, tempFile = { inputData:{}, outputData: {}, messages: [] }) {
    this.portPath = portPath;
    this.baudRate = baudRate;
    this.logger = logger;
    this.port = null;
    this.timeoutStepOn = timeoutStepOn;
    this.polling = polling;
    this.pollingInterval = null;
    this._rxBuf = Buffer.alloc(0);
    this.enabled = false;
    this.result = null;
    this.currentState = "undefined";
    this.pendingResolve = null;
    this.pendingReject = null;
    this.pendingTimeout = null;
    this.stepOnTimeout = null;
    this.measureStarted = false;
    this.lastImpedanceCode = null;
    this.sameImpedanceCounter = 0;
    this.terminator = "\r\n";
    this.timeout = timeout;
    this.emitMessage = emitMessage;
    this.tempFile = tempFile;
    this.errorMap = new Map(arrayMap);
    this.tanita = this._createMachine({
      initialState: 'undefined',
      undefined: {
        actions: {
          onEnter() { this.logger.debug('undefined: onEnter'); },
          async onExit() {
            this.logger.debug('undefined: onExit');
            message = await this._sendAndReceive(COMMANDS.CHECK_STATUS, "");
            this._checkResponse(message);
          },
        },
        transitions: {
          [COMMANDS.RESET]: {
            target: STATES.INIT,
            async action() {
              this.logger.info('going to S0 with transition Q');
              try {
                message = await this._sendAndReceive(COMMANDS.RESET, '');
                this._checkResponse(message);
              } catch (e) {
                this._clear();
                this._emitError(new Error(this.errorMap.get(E_Platform), {cause:E_Platform}));
              }
            }
          },
        },
      },
      [STATES.INIT]: {
        actions: {
          onEnter() { this.logger.info('S0: onEnter'); },
          onExit() { this.logger.info('S0: onExit'); },
        },
        transitions: {
          [COMMANDS.NOPC_TO_PC]: {
            target: STATES.PREPARE_SETUP,
            async action() {
              this.logger.info('going to S1 with transition M1');
              try {
                message = await this._sendAndReceive(COMMANDS.NOPC_TO_PC, '');
                this._checkResponse(message);
              } catch (e) {
                this._clear(true);
                this._emitError(new Error(this.errorMap.get(E_Communication), {cause:E_Communication}));
              }
            }
          },
        },
      },
      [STATES.PREPARE_SETUP]: {
        actions: {
          async onEnter() {
            this.logger.info('S1: onEnter');
            await this._sendParameters(this.tempFile.inputData);
          },
          onExit() { this.logger.info('S1: onExit'); },
        },
        transitions: {
          [STATES.SETUP_COMPLETED]: {
            target: STATES.SETUP_COMPLETED,
            action() { this.logger.info('going to S2'); }
          },
        },
      },
      [STATES.SETUP_COMPLETED]: {
        actions: {
          onEnter() { this.logger.info('S2: onEnter'); },
          onExit() { this.logger.info('S2: onExit'); },
        },
        transitions: {
          [COMMANDS.MEASURE_WEIGHT]: {
            target: STATES.SETTING_ZERO_POINT,
            async action() {
              try {
                message = await this._sendAndReceive(COMMANDS.MEASURE_WEIGHT, '');
                this._checkResponse(message);
              } catch (e) {
                this._clear(true);
                this._emitError(new Error(this.errorMap.get(E_Communication), {cause:E_Communication}));              
              }
            }
          },
          [COMMANDS.MEASURE_BODY_COMPOSITION]: {
            target: STATES.SETTING_ZERO_POINT,
            async action() {
              message = await this._sendAndReceive(COMMANDS.MEASURE_BODY_COMPOSITION, '');
              this._checkResponse(message);
            }
          },
          [COMMANDS.RESET]: {
            target: STATES.INIT,
            async action() {
              this.logger.info('going to S0 with transition Q');
              try {
                message = await this._sendAndReceive(COMMANDS.RESET, '');
                this._checkResponse(message);
              } catch (e) {
                this._clear();
                this._emitError(new Error(this.errorMap.get(E_Platform), {cause:E_Platform})); 
              }
            }
          },
        }
      },
      [STATES.SETTING_ZERO_POINT]: {
        actions: {
          onEnter() { this.logger.info('S3: onEnter'); },
          onExit() { this.logger.info('S3: onExit'); },
        },
        transitions: {
          [STATES.MEASURING_WEIGHT]: {
            target: STATES.MEASURING_WEIGHT,
            action() { }
          }
        }
      },
      [STATES.MEASURING_WEIGHT]: {
        actions: {
          onEnter() {
            this.emitMessage({ outputData: { message: "step_on" } });
            this.logger.info('S4: onEnter');
            this.stepOnTimeout = setTimeout(() => {
              if(!this.measureStarted) return;
              this.measureStarted = false;
              this._clear();
              this._emitError(new Error(this.errorMap.get(E_NoStep), {cause:E_NoStep}));
            }, this.timeoutStepOn)
          },
          onExit() { 
            this.logger.info('S4: onExit'); 
            clearTimeout(this.stepOnTimeout);
            this.stepOnTimeout = undefined;
          },
        },
        transitions: {
          [STATES.DETECT_CONTACT]: {
            target: STATES.DETECT_CONTACT,
            action() { }
          }
        }
      },
      [STATES.DETECT_CONTACT]: {
        actions: {
          onEnter() { this.logger.info('SD: onEnter'); },
          onExit() { this.logger.info('SD: onExit'); },
        },
        transitions: {
          [COMMANDS.MEASURE_IMPEDANCE_50KHZ]: {
            target: STATES.MEASURING_BI,
            async action() {
              this.emitMessage({ outputData: { message: "BI_50KHZ" } });
              message = await this._sendAndReceive(COMMANDS.MEASURE_IMPEDANCE_50KHZ, '');
              this._checkResponse(message);
            }
          }
        },
      },
      [STATES.MEASURING_BI]: {
        actions: {
          onEnter() {
            this.emitMessage({ outputData: { message: "grip_on" } });
            this.logger.info('S6: onEnter');
          },
          onExit() { this.logger.info('S6: onExit'); },
        },
        transitions: {
          [COMMANDS.MEASURE_IMPEDANCE_6_25KHZ]: {
            target: STATES.OUTPUTTING_DATA,
            async action() {
              this.emitMessage({ outputData: { message: "BI_6_25KHZ" } });
              message = await this._sendAndReceive(COMMANDS.MEASURE_IMPEDANCE_6_25KHZ, '');
              this._checkResponse(message);
            }
          }
        }
      },
      [STATES.OUTPUTTING_DATA]: {
        actions: {
          onEnter() { this.logger.info('SB: onEnter'); },
          onExit() {
            this.measureStarted = false;
            this.logger.info('SB: onExit');
            this.emitMessage({ outputData: { message: "BI_measure_completed" } });
          },
        },
        transitions: {
          [COMMANDS.CHECK_STEP_OFF]: {
            target: STATES.DETECTING_STEP_OFF,
            action() { }
          }
        }
      },
      [STATES.DETECTING_STEP_OFF]: {
        actions: {
          onEnter() {
            this.logger.info('S7: onEnter');
          },
          onExit() { this.logger.info('S7: onExit'); },
        },
        transitions: {
          [STATES.INIT]: {
            target: STATES.INIT,
            action() { }
          }
        }
      }
    }, this)
  }

  _sleep(secs) {
    return new Promise((resolve) => {
      setTimeout(resolve, secs * 1000); // Convert seconds to milliseconds
    });
  }

  _createMachine(stateMachineDefinition, context) {
    const machine = {
      value: stateMachineDefinition.initialState,
      transition(currentState, event) {
        const currentStateDefinition = stateMachineDefinition[currentState];
        const destinationTransition = currentStateDefinition.transitions[event];
        if (!destinationTransition) {
          return;
        }
        const destinationState = destinationTransition.target;
        const destinationStateDefinition = stateMachineDefinition[destinationState];

        destinationTransition.action.call(context);
        currentStateDefinition.actions.onExit.call(context);
        destinationStateDefinition.actions.onEnter.call(context);
        machine.value = destinationState;

        return machine.value;
      },
    }
    return machine
  }

  // -- Open serial port -------------------------------------------------------

  async open() {
    return new Promise((resolve, reject) => {
      this.port = new SerialPort({
        path: this.portPath,
        baudRate: this.baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        autoOpen: true,
      }, (err) => {
        if (err) return reject(new Error(`Cannot open ${this.portPath}: ${err.message}`));
        this.logger.info(` ? Serial port opened: ${this.portPath} @ ${this.baudRate} bps`);
        resolve();
      });
      const parser = this.port.pipe(new DelimiterParser({ delimiter: this.terminator }));
      parser.on('data', (chunk) => this._onData(chunk));
      this.port.on('error', (err) => this.logger.error(`Serial error: ${err.message}`));
    });
  }

  // -- Close serial port ------------------------------------------------------

  async close() {
    return new Promise((resolve) => {
      if (this.port?.isOpen) {
        this.logger.info(` ? Serial port closed`);
        this.port.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  // -- Internal data handler --------------------------------------------------

  _onData(chunk) {
    this._rxBuf = Buffer.concat([this._rxBuf, chunk]);
    this._parseResponse(this._rxBuf);
  }

  // -- Internal error handler --------------------------------------------------
  
  _emitError(err){
    this.logger.error(` > zmq error: ${err.message}`);
    this.emitMessage({ outputData:{
      message: "error",
      errorCode: err.cause
    }});
  }

  // -- Clear dependencies --------------------------------------------------

  _clear(reset = false){

    if (this.pendingTimeout) {
      clearTimeout(this.pendingTimeout);
      this.pendingTimeout = null;
    }

    if (this.stepOnTimeout) {
      clearTimeout(this.stepOnTimeout);
      this.stepOnTimeout = null;
    }

    this.measureStarted = false;
    this.pendingResolve = null;
    this.pendingReject = null;
    this._rxBuf = Buffer.alloc(0);
    this.lastImpedanceCode = null;
    this.sameImpedanceCounter = 0;

    // -- Reset device
    if(reset){
      this.currentState = "undefined";
      this.currentState = this.tanita.transition(this.currentState, COMMANDS.RESET);
    }

    if (this.port?.isOpen) {
      this.port.flush(() => {
        this.logger.info('? Serial port flush');
      });

      this.port.drain(() => {
        this.logger.info('? Serial port drain');
      });
    }
  }

  /**
   * Parse response frame.
   *
   * Returns { ok, data } where data is a Buffer (may be empty).
   */
  _parseResponse(buf) {
    const message = buf.toString();
    if (this.enabled) {
      this.logger.debug(` buffer: ${buf.toString()}`);
      this.result = { output: buf.toString() };
    }
    this._rxBuf = Buffer.alloc(0);

    if (this.pendingResolve) {
      clearTimeout(this.pendingTimeout);
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      this.pendingReject = null;
      this.pendingTimeout = null;

      resolve(message);
      return;
    }

    this._checkResponse(message);
  }

  _calculateTare(data) {
    let tare = 0;
    if (data.clothing === "lightClothing") {
      tare = 0.5;
    } else if (data.clothing === "normalClothing") {
      tare = 1;
    } else {
      tare = 1.3;
    }

    if (data.shoes === "runningShoes") {
      tare += 0.3;
    } else if (data.shoes === "sneakers") {
      tare += 0.6;
    } else if (data.shoes === "leatherShoes") {
      tare += 1;
    } else {
      tare += 2.5;
    }
    const returnTare = tare.toString();
    return returnTare.length === 3 ? "0" + returnTare : returnTare;
  }

  _convertGender(data, callback) {
    if (data.genre === "male") {
      return "1";
    } else if (data.genre === "female") {
      return "2";
    } else {
      callback();
    }
  }

  _convertBodyType(data, callback) {
    if (data.bodyType === "normal") {
      return "0";
    } else if (data.bodyType === "athletic") {
      return "2";
    } else {
      callback();
    }
  }

  _convertHeight(data) {
    return data.height + ".0";
  }

  _algoritmoMassaMagra(boneMass, muscleMass, weight) {
    const massaMagra = parseFloat(boneMass) + parseFloat(muscleMass);
    const peso = parseFloat(weight);
    const perc = (massaMagra / peso) * 100;
    return parseInt(perc);
  }

  _bCScoreAlgorithm(age, metabolicAge) {
    age = parseFloat(age);
    metabolicAge = parseFloat(metabolicAge);
    const ret = parseInt(70 - ((metabolicAge - age) / age) * 100);

    if (ret > 100) {
      return "100";
    } else {
      return ret.toString();
    }
  }

  _stringToJSON(inputString) {
    const parts = inputString.split(",");
    const result = {};

    for (let i = 0; i < parts.length; i += 2) {
      const key = parts[i];
      const value = parts[i + 1];
      result[key] = value;
    }

    return JSON.stringify(result);
  }

  _inputError(data) {
    if (!data?.inputData) return true;
    const { age, bodyType, genre, height, clothingWeight, clothing, shoes } = data.inputData;
    if (!age || !bodyType || !genre || !height) return true;
    if (!clothingWeight) {
      if (!clothing || !shoes) return true;
    }
    return false;
  }

  // Send command to device
  _sendAndReceive(cmd, msg) {

    if (this.pendingResolve || this.pendingReject) {
      clearTimeout(this.pendingTimeout);
      this.pendingResolve = null;
      this.pendingReject = null;
      this.pendingTimeout = null;
    }

    const messageToSend = cmd + msg + this.terminator;
    this.logger.debug(`-> ${messageToSend}`);

    return new Promise((resolve, reject) => {

      this.pendingResolve = resolve;
      this.pendingReject = reject;

      // Write the message (add line ending expected by the device)
      this.port.write(messageToSend, (err) => {
        if (err) {
          clearTimeout(this.pendingTimeout);
          this.pendingResolve = null;
          this.pendingReject = null;
          this.pendingTimeout = null;
          reject(err);
        }
      });

      // Timeout handling
      this.pendingTimeout = setTimeout(() => {
        if (this.pendingReject) {
          this.pendingReject(new Error(this.errorMap.get(E_Timeout), {cause:E_Timeout}));
        }
        this.pendingResolve = null;
        this.pendingReject = null;
        this.pendingTimeout = null;
        if (this.currentState !== STATES.INIT) {
          this._clear(true);
          this._emitError(new Error(this.errorMap.get(E_Timeout), {cause:E_Timeout}));
        }
      }, this.timeout);
    });
  }

  async _sendParameters(data) {
    if (this._inputError({ inputData: data })) {
      this._emitError(new Error(this.errorMap.get(E_DataSent), {cause:E_DataSent}));
      this._clear(true);
      return;
    }

    this.logger.info("Preparing Setup");
    this._checkResponse(await this._sendAndReceive(COMMANDS.INPUT_TARE, this._calculateTare(data)));
    this._checkResponse(await this._sendAndReceive(COMMANDS.INPUT_GENDER, this._convertGender(data, () => { 
      this._emitError(new Error(this.errorMap.get(E_NoData), {cause:E_NoData})); 
      this._clear(true); 
    })));
    this._checkResponse(await this._sendAndReceive(COMMANDS.INPUT_BODY_TYPE, this._convertBodyType(data, () => { 
      this._emitError(new Error(this.errorMap.get(E_NoData), {cause:E_NoData})); 
      this._clear(true); 
    })));
    this._checkResponse(await this._sendAndReceive(COMMANDS.INPUT_HEIGHT, this._convertHeight(data)));
    this._checkResponse(await this._sendAndReceive(COMMANDS.INPUT_AGE, data.age));
    this._checkResponse(await this._sendAndReceive(COMMANDS.INPUT_ID, '"0000000000000001"'));
    this._checkResponse(await this._sendAndReceive(COMMANDS.INPUT_TARGET_FAT, '20'));
    this._checkResponse(await this._sendAndReceive(COMMANDS.CHECK_INFO_INPUT, ""));
  }

  async _checkResponse(data) {
    let commandEcho = [];
    if (data && data.length > 1) {
      commandEcho = data.split(",");
      if (
        data.startsWith("D0,Pt")
        && data.includes("D1,GE")
        && data.includes("D2,Bt")
        && (data.includes("D3,Hm") || data.includes("D3,Hi"))
        && data.includes("D4,AG")
        && data.includes("D5,ID")
        && data.includes("D6,gF")
      ) {
        // Echos:
        // [0] - D?
        // [1] - D0 - Tare
        // [2] - D1 - Gender
        // [3] - D2 - Body type
        // [4] - D3 - Height
        // [5] - D4 - Age
        // [6] - D5 - ID
        // [7] - D6 - Fat %
        // Response template : D0,Pt,<D0>,D1,GE,<D1>,D2,Bt,<D2>,D3,Hm/Hi,<D3>,D4,AG,<D4>,D5,ID,<D5>,D6,gF,<D6>

        this.currentState = this.tanita.transition(STATES.PREPARE_SETUP, STATES.SETUP_COMPLETED);
        this.emitMessage({ outputData: { message: "setup_completed" } });
        this.logger.info(`D? response : ${data}`)
        return;
      }
    } else {
      commandEcho[0] = data;
    }
    switch (commandEcho[0]) {
      case '@':
        // Mode switch                   :  
        // Measure body composition      : S9 
        // Measure weight                : S3 & Start measuring weight
        // Measure impedance (50kHz)     : S5 
        // Measure impedance (6.25kHz)   : S6
        // Check step off platform       : S9
        const message = await this._sendAndReceive(COMMANDS.CHECK_STATUS, "");
        this._checkResponse(message);
        return;
      case COMMANDS.INPUT_TARE:
        this.logger.info(`tare input : ${commandEcho[2]}`);
        return;
      case COMMANDS.INPUT_GENDER:
        this.logger.info(`gender input : ${commandEcho[2]}`);
        return;
      case COMMANDS.INPUT_BODY_TYPE:
        this.logger.info(`bt input : ${commandEcho[2]}`);
        return;
      case COMMANDS.INPUT_HEIGHT:
        this.logger.info(`height input : ${commandEcho[2]}`);
        return;
      case COMMANDS.INPUT_AGE:
        this.logger.info(`age input : ${commandEcho[2]}`);
        return;
      case COMMANDS.MEASURE_WEIGHT:
        if (this.stepOnTimeout) {
          clearTimeout(this.stepOnTimeout);
          this.stepOnTimeout = null;
        }
        this.logger.info('weight measure completed');
        this.emitMessage({ outputData: { message: "BW_measure_completed" } });
        this.currentState = this.tanita.transition(this.currentState, STATES.DETECT_CONTACT);
        return;
      case STATES.ZERO_POINT_ERROR:
        this.emitMessage({ outputData: { message: "zero_point_error", code: 260 } });
        return;
      case STATES.COMPLETED_SET_ZERO_POINT:
        this.emitMessage({ outputData: { message: "zero_point_ok" } });
        this.currentState = this.tanita.transition(STATES.SETTING_ZERO_POINT, STATES.MEASURING_WEIGHT);
        return;
      case COMMANDS.MEASURE_IMPEDANCE_50KHZ:
        this.logger.info("Impedance 50KHZ");
        this.currentState = this.tanita.transition(STATES.MEASURING_BI, COMMANDS.MEASURE_IMPEDANCE_6_25KHZ);
        return;
      case COMMANDS.MEASURE_IMPEDANCE_6_25KHZ:
        this.logger.info("Impedance 6_25KHZ");
        this._checkResponse(await this._sendAndReceive(COMMANDS.CALCULATION_AND_OUTPUT, ''));
        return;
      case STATES.INIT:
        this.currentState = STATES.INIT;
        return;
      case STATES.PREPARE_SETUP:
        if (!this.currentState) {
          this.currentState = this.tanita.transition(this.currentState, COMMANDS.RESET);
          await this._sleep(2);
        } else {
          this.currentState = STATES.PREPARE_SETUP;
        }
        return;
      case STATES.SETUP_COMPLETED:
        if (this.measureStarted) {
          this.currentState = this.tanita.transition(STATES.PREPARE_SETUP, STATES.SETUP_COMPLETED);
        } else {
          this.currentState = this.tanita.transition(STATES.SETUP_COMPLETED, COMMANDS.RESET);
        }
        return;
      case STATES.DETECT_NON_CONTACT:
        return;
      case STATES.SETTING_ZERO_POINT:
        this.currentState = this.tanita.transition(STATES.SETUP_COMPLETED, STATES.MEASURING_WEIGHT);
        return;
      case STATES.MEASURING_WEIGHT:
        this.currentState = this.tanita.transition(STATES.SETTING_ZERO_POINT, STATES.MEASURING_WEIGHT);
        return;
      case STATES.MEASURING_BI:
        return;
      case STATES.DETECT_CONTACT:
        this.logger.info("Starting impedance");
        this.currentState = STATES.DETECT_CONTACT;
        return;
      case STATES.OUTPUTTING_DATA:
        this.logger.info("Outputting data");
        return;
      case "I56":
      case "I55":
      case "I54":
      case "I53":
      case "I52":
      case "I51":
      case "I50":
      case "I66":
      case "I65":
      case "I64":
      case "I63":
      case "I62":
      case "I61":
      case "I60":
        if (data === this.lastImpedanceCode) {
          this.sameImpedanceCounter++;
        } else {
          this.lastImpedanceCode = data;
          this.sameImpedanceCounter = 0;
        }

        if (this.sameImpedanceCounter >= 3) {
          this.emitMessage({ outputData: { message: "impedance_error", code: 270 } });
        }
        return;
      case STATES.MEASURING_50KHZ:
      case STATES.MEASURING_6_25KHZ:
      case STATES.DETECTING_STEP_OFF:
        if (!this.currentState && commandEcho[0] != STATES.INIT && commandEcho[0] != STATES.PREPARE_SETUP) {
          this.currentState = this.tanita.transition(this.currentState, COMMANDS.RESET);
          await this._sleep(2);
        }
        return;
      default:
        if (this.currentState == STATES.OUTPUTTING_DATA) {
          const result = JSON.parse(this._stringToJSON(data.replace("{", "").replace('"', "")));
          this.tempFile.outputData = {
            message: "measure_finish",
            bmi: parseFloat(result.MI),
            weight: parseFloat(result.Wk),
            clothingWeight: parseFloat(result.Pt),
            fatMass: parseFloat(result.FW),
            boneMass: parseFloat(result.bW),
            muscleMass: parseFloat(result.mW),
            muscleScore: parseFloat(result.sW),
            bodyWater: parseFloat(result.ww),
            visceralFat: parseFloat(result.IF),
            restingMetabolicRate: parseFloat(result.rB),
            metabolicAge: parseFloat(this._bCScoreAlgorithm(this.tempFile.inputData.age, result.rA)), //calculate metabolic age from age and returned metabolic age
            leanMass: this._algoritmoMassaMagra(result.bW, result.mW, result.Wk), //calculate leanMass from calculated bone mass, calculated muscle mass and calculated weight
          };
          this.logger.info(this.tempFile.outputData);
          this.emitMessage(this.tempFile);
          this.currentState = this.tanita.transition(this.currentState, COMMANDS.CHECK_STEP_OFF);
        }
        return;
    }
  }

  // -- End Internal data handler --------------------------------------------------

  async measureStart(data) {
    this.tempFile.inputData = {
      bodyType: data.bodyType,
      shoes: data.shoes,
      age: data.age,
      height: data.height,
      genre: data.genre,
      clothing: data.clothing
    };
    if (!this.measureStarted) {
      this.measureStarted = true;
      this.currentState = this.tanita.transition(STATES.INIT, COMMANDS.NOPC_TO_PC);
    } else {
      this.logger.error("already_started");
      this.emitMessage({ outputData: { message: "already_started" } });
    }
  }

  async measureBW() {
    if (this.currentState && this.currentState == STATES.SETUP_COMPLETED) {
      this.currentState = this.tanita.transition(this.currentState, COMMANDS.MEASURE_WEIGHT);
    } else {
      this.logger.error(`current state is not S2, current state: ${this.currentState}`);
      if (this.currentState && this.currentState == STATES.DETECT_CONTACT) {
        this.currentState = this.tanita.transition(this.currentState, COMMANDS.MEASURE_IMPEDANCE_50KHZ);
      } else {
        this.logger.error(`current state is not SD, current state : ${this.currentState}`);
        throw new Error(this.errorMap.get(E_GenericOnPlugin), {cause:E_GenericOnPlugin});
      }
    }
  }

  async measureBI() {
    if (this.currentState && this.currentState == STATES.DETECT_CONTACT) {
      this.currentState = this.tanita.transition(this.currentState, COMMANDS.MEASURE_IMPEDANCE_50KHZ);
    } else {
      this.logger.error(`current state is not SD, current state : ${this.currentState}`);
      throw new Error(this.errorMap.get(E_GenericOnPlugin), {cause:E_GenericOnPlugin});
    }
  }

  async measureStop() {
    this.currentState = STATES.INIT;
    this._clear();
  }

  async checkStatus() {
    const message = await this._sendAndReceive(COMMANDS.CHECK_STATUS, "");
    this._checkResponse(message); 
  }

  async resetMachine() {
    this.currentState = "undefined";
    this._clear();
    this.currentState = this.tanita.transition(this.currentState, COMMANDS.RESET);
  }
}
// -----------------------------------------------------------------------------
// Module exports
// -----------------------------------------------------------------------------

module.exports = {
  TanitaDC13C
};
