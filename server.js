const WebSocketServer = require('ws');

const wss = new WebSocketServer.Server({port: 8191});

wss.on("connection", ws => {
    console.log("new client connected");

    ws.on("message", data => {
        let json_data = JSON.parse(data);
        let json_content = json_data.content;
        console.log(json_data);
        console.log(json_content.name);
        json_content.name = "Foobar";
        ws.send(JSON.stringify(json_data));
    });


    ws.on("close", () => {
        console.log('client disconnected');
    });

    ws.onerror = function () {
        console.log("error occured");
    }
});
console.log("Websocket running on port 8191");