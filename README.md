# Project Setup Instructions (check it in code mode or raw version for readability)

For this to work you have to follow the file structure exactly as shown below.

## Required File Structure

lib/
│
├── queue.js
├── logger.js
├── config.js
│
└── src/
      ├── mise.toml(optional)
      ├── config.json
      ├── package.json
      ├── main.js
      └── TanitaDC13C.js

 ## Package.json dependencies (check electron documentation on how to structure it for your build)

 - serialPort
 - zeromq

 ## Config.json
 
 Change the variables as you need, it should match your specific device, you can also customize the timers etc.

## Important Notes

### 1. `debug.log`
It will create a `debug.log` file in the directory spicified in the config.  
It will automatically populate with debug logs during runtime.

## Test Application Requirement

You must create a **test application** based on this project.

### Purpose

The test application should:

- Send messages via **ZeroMQ**
- Use the **same address** as the main application
- Communicate with the device/plugin

### Messages to Send

The test app must send the following messages:

- `measureStart` with the data payload (follow the payload structure at the bottom)
- `measureBW`
- `measureBI`
- `measureStop`

### Communication Flow

- The test project communicates with the plugin
- The plugin responds with messages back to the test app
- This simulates a **front-end emulation**

You are free to implement this test project however you prefer, depending on your goal and architecture.

## Summary

✔ Follow the exact folder structure  
✔ Add the path for the `debug.log` file  
✔ Implement a ZeroMQ test app that sends:
- `measureStart`
- `measureBW`
- `measureBI`
- `measureStop`

✔ Ensure bidirectional communication with the plugin (front-end emulation)

### Payload structure
{
      "command":{
        "inputData": { 
          "cmd": "measureStart", 
          "bodyType": "normal",
          "shoes": "sneakers",
          "age": 22,
          "height": 173,
          "genre": "male",
          "clothing": "heavyClothing" 
        },
        "outputData": {}
        }
}

the other messages should have the following structure: 
{
      "command":{
        "inputData": { 
          "cmd": "measureBW"
        },
        "outputData": {}
        }
}

and so on.

