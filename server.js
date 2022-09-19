const WebSocketServer = require('ws');

const wss = new WebSocketServer.Server({port: 8191});

const connectedUsers = new Set();
const games = [];

connectedUsers.broadcast = function(data, except) {
    for (let user of connectedUsers) {
        if (user !== except) {
            user.send(data);
        }
    }
}

function getGame(id) {
    for (let game of games) {
        if (game.id === id) {
            return game;
        }
    }
    return null;
}

function getPlayer(id, playerlist) {
    for (let player of playerlist) {
        if (player.id === id) {
            return player;
        }
    }
    return null;
}

wss.on("connection", ws => {
    console.log("new client connected");
    connectedUsers.add(ws);

    ws.on("message", data => {
        let json_data = JSON.parse(data);
        let msg_content = json_data.content;
        //console.log(msg_content);
        if (msg_content.create) { //Create a game instance
            games.push({
                id: games.length + 1,
                name: msg_content.create.name,
                max_players: msg_content.create.max_players,
                type: msg_content.create.type,
                current_turn: 0,
                turn_count: 0,
                players: [],
            });
            console.log('game created')
            //connectedUsers.broadcast(JSON.stringify(games));
        }
        else if (msg_content.start) { //figure out turns and start the game
            if (msg_content.game_id) {
                console.log('starting the game');
                let game_data = getGame(msg_content.game_id);
                if (game_data && game_data) {
                    for (let i = 0; i < game_data.players.length; i++) {
                        let r = i + Math.floor(Math.random() * (game_data.players.length - i));
                        let temp = game_data.players[r];
                        game_data.players[r] = game_data.players[i];
                        game_data.players[i] = temp;
                    }
                    let play_order = [];
                    for (let i = 0; i < game_data.players.length; i++) {
                        play_order.push({ id: game_data.players[i].id, turn: i});
                        game_data.players[i].turn = i;
                    }
                    game_data.turn_count = 1;
                    console.log(play_order);
                    connectedUsers.broadcast(JSON.stringify({play_order: play_order}), 4);
                }
            }

        }
        else if (msg_content.request) {
            if (msg_content.request === 'games') {
                console.log('sending games');
                ws.send(JSON.stringify({games: games}));
            }
            else if (msg_content.request === 'game_data') {
                if (msg_content.game_id) {
                    let game_data = getGame(msg_content.game_id);
                    if (game_data) {
                        console.log('sending game data');
                        ws.send(JSON.stringify(
                            {game_data: game_data}
                        ));
                    }
                    else {
                        ws.send(JSON.stringify({game_data: {}}));
                    }
                }
            }
            else if (msg_content.request === 'player_change') {
                if (msg_content.game_id && msg_content.player_data) {
                    let game_data = getGame(msg_content.game_id);
                    if (game_data.players != null) {
                        if (getPlayer(msg_content.player_data.id, game_data.players) != null) {
                            for (let i = 0; i < game_data.players.length; i++) {
                                if (game_data.players[i].id === msg_content.player_data.id){
                                    game_data.players[i] = msg_content.player_data.player;
                                }
                            }
                        }
                        let out = true;
                        if (getPlayer(msg_content.player_data.id, game_data.players) == null) {
                            if (game_data.turn_count > 0) { //the game is in progress
                                game_data.players.push(msg_content.player_data.player);
                            }
                            else {
                                game_data.players.push(msg_content.player_data.player);
                            }
                        }
                        if (out) {
                            if (msg_content.player_data.new_deck) {
                                connectedUsers.broadcast(JSON.stringify({player_data: msg_content.player_data.player}), 4);
                            }
                            else {
                                connectedUsers.broadcast(JSON.stringify({player_data: msg_content.player_data.player}), ws);
                            }
                        }
                    }
                }
            }
            else if (msg_content.request === 'player_and_temp_change') {
                if (msg_content.game_id && msg_content.player_data && msg_content.temp_zone) {
                    console.log('temp zone!!')
                    console.log(msg_content);
                    let game_data = getGame(msg_content.game_id);
                    for (let i = 0; i < game_data.players.length; i++) {
                        if (game_data.players[i].id === msg_content.player_data.id){
                            game_data.players[i] = msg_content.player_data.player;
                        }
                        if (game_data.players[i].id === msg_content.temp_id) {
                            switch (msg_content.temp_zone_name) {
                                case 'grave':
                                    game_data.players[i].grave = msg_content.temp_zone;
                                    break;
                                case 'exile':
                                    game_data.players[i].exile = msg_content.temp_zone;
                                    break;
                                case 'temp_zone':
                                    game_data.players[i].temp_zone = msg_content.temp_zone;
                                    break;
                                case 'hand':
                                    game_data.players[i].hand = msg_content.temp_zone;
                                    break;
                                case 'deck':
                                    game_data.players[i].deck.cards = msg_content.temp_zone;
                                    break;
                                case 'commander':
                                    game_data.players[i].deck.commander = msg_content.temp_zone;
                                    break;
                            }
                        }
                    }
                    connectedUsers.broadcast(JSON.stringify({player_temp_data: msg_content.player_data.player, temp_id: msg_content.temp_id, temp_zone: msg_content.temp_zone, temp_zone_name: msg_content.temp_zone_name}), ws);
                }
            }
            else if (msg_content.request === 'end_turn') {
                let game_data = getGame(msg_content.game_id);
                let previous_turn = JSON.parse(JSON.stringify(game_data.current_turn));
                while (true) {
                    game_data.current_turn ++;
                    console.log(game_data.current_turn);
                    console.log(previous_turn);
                    if (game_data.current_turn > game_data.players.length - 1) {
                        game_data.current_turn = 0;
                    }
                    if (game_data.current_turn === previous_turn) { //everyone has scooped, why are you ending the turn
                        console.log('bad');
                        break;
                    }
                    let good = false;
                    for (let player of game_data.players) {
                        if (player.turn === game_data.current_turn) {
                            if (player.scooped) {
                                continue;
                            }
                            else {
                                good = true;
                                break;
                            }
                        }
                    }
                    if (good) {
                        break;
                    }
                }
                console.log('turn update');
                connectedUsers.broadcast(JSON.stringify({turn_data: {turn_count: game_data.turn_count, current_turn: game_data.current_turn}}), 4);
            }
            else if (msg_content.request === 'shake') {
                let game_data = getGame(msg_content.game_id);
                if (msg_content.card) {
                    connectedUsers.broadcast(JSON.stringify({shake_data: {cardid: msg_content.card.id, userid: msg_content.card.user, location: msg_content.card.location}}), ws);
                }
            }
        }
    });


    ws.on("close", () => {
        console.log('client disconnected');
        connectedUsers.delete(ws);
    });

    ws.onerror = function () {
        console.log("error occured");
    }
});
console.log("Websocket running on port 8191");