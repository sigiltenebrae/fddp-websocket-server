const WebSocketServer = require('ws');
const config = require("./db.config");
const {getGameById} = require("./queries");

const Pool = require('pg').Pool
const pool = new Pool({
    user: config.USER,
    host: config.HOST,
    database: config.DB,
    password: config.PASSWORD,
    port: 5432,
});

const wss = new WebSocketServer.Server({port: 8191});

const connectedUsers = new Set();
const game_types = {};
const games = [];

connectedUsers.broadcast = function(data, except) {
    for (let user of connectedUsers) {
        if (user !== except) {
            user.send(data);
        }
    }
}

function getGameTypes() {
    return new Promise((resolve) => {
        pool.query('SELECT * FROM game_types',
            (error, results) => {
                if (error) {
                    console.log('Error getting all game types');
                    console.log(error);
                    resolve();
                }
                else {
                    if (results.rows && results.rows.length > 0) {
                        for (let row of results.rows) {
                            game_types[String(row.name)] = row.id;
                        }
                        resolve();
                    }
                    else {
                        resolve();
                    }
                }
            });
    })
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

function getActiveGames() {
    return new Promise((resolve) => {
        pool.query('SELECT * FROM games WHERE active = true',
            (error, results) => {
                if (error) {
                    console.log('Error getting active games');
                    console.log(error);
                    resolve({errors: [error]});
                }
                else {
                    if (results.rows && results.rows.length > 0) {
                        resolve(results.rows);
                    }
                    else {
                        resolve([]);
                    }
                }
            });
    })
}

function createGame(name, type, max_players, active) {
    return new Promise((resolve) => {
        pool.query('INSERT INTO games (name, type, max_players, active) VALUES ($1, $2, $3, true) RETURNING *',
            [name, type, max_players],
            (error, results) => {
                if (error) {
                    console.log('game creation failed');
                    console.log(error);
                    resolve({errors: [error]});
                }
                let new_id = results.rows[0].id;
                if (new_id > -1) {
                    resolve({game_id: new_id});
                }
                else {
                    console.log('game creation failed');
                    console.log(error);
                    resolve({errors: []});
                }
            });
    })
}

function endGame(winner, winner_two, id) {
    return new Promise((resolve) => {
        pool.query('UPDATE games SET active = $1, winner = $2, winner_two = $3, game_data = $4 WHERE id = $5',
            [false, winner, winner_two, null, id],
            (error, results) => {
                if (error) {
                    console.log('Game end failed for deck with id: ' + id);
                    console.log(error);
                    resolve({errors: [error]});
                }
                else {
                    console.log('game ended with id ' + id);
                    games.splice(games.indexOf(getGame(id)), 1);
                    resolve({message: 'game end successful'});
                }
            })
    })
}

function startGame(game) {
    return new Promise((resolve) => {
        pool.query('UPDATE games SET started = now() WHERE id = $1',
            [game.id],
            (error, results) => {
                if (error) {
                    console.log('Game start failed for deck with id: ' + game.id);
                    console.log(error);
                    resolve({errors: [error]});
                }
                else {
                    console.log('game started with id ' + game.id);
                    resolve({message: 'game start successful'});
                }
            });
    })
}

function backupGame(game) {
    return new Promise((resolve) => {
        pool.query('UPDATE games SET game_data = $1 WHERE id = $2',
            [game, game.id],
            (error, results) => {
                if (error) {
                    console.log('Game backup failed for deck with id: ' + game.id);
                    console.log(error);
                    resolve({errors: [error]});
                }
                else {
                    console.log('game backed up with id ' + game.id);
                    resolve({message: 'game update successful'});
                }
            });
    })
}

function backupGames() {
    if (games.length > 0) {
        let backupPromises = [];
        let trashPromises = [];
        for (let game of games) {
            console.log('game age for game ' + game.id + ': ' + ((Math.abs(Date.now() - game.last_modified) / 1000)/ 60) + ' minutes');
            if (((Math.abs(Date.now() - game.last_modified) / 1000)/ 60) > 10) {
                trashPromises.push(endGame(null, null, game.id));
            }
            else {
                backupPromises.push(backupGame(game));
            }
        }
        Promise.all(backupPromises).then(() => {
            console.log('games backed up');
        });
        Promise.all(trashPromises).then(() => {
            console.log('games cleared out');
        })

    }
}

function logActionSend(game_data) {
    connectedUsers.broadcast(JSON.stringify({action_log: game_data.action_log}), 4);
}

function getTeam(player, game_data) {
    for (let team of game_data.team_data) {
        for (let team_player of team.players) {
            if (player === team_player) {
                return team;
            }
        }
    }
    return null;
}

function setVisibility(card, dest_type, game_data) {
    switch(dest_type) {
        case 'deck':
            card.visible = [];
            break;
        case 'grave':
            card.visible = [];
            if (game_data.players) {
                for (let player of game_data.players) {
                    card.visible.push(player.id);
                }
                for (let player of game_data.spectators) {
                    card.visible.push(player.id);
                }
            }
            break;
        case 'exile':
            if (!card.facedown) {
                card.visible = [];
                if (game_data.players) {
                    for (let player of game_data.players) {
                        card.visible.push(player.id);
                    }
                    for (let player of game_data.spectators) {
                        card.visible.push(player.id);
                    }
                }
            }
            break;
        case 'commander':
            card.visible = [];
            if (game_data.players) {
                for (let player of game_data.players) {
                    card.visible.push(player.id);
                }
                for (let player of game_data.spectators) {
                    card.visible.push(player.id);
                }
            }
            break;
        case 'temp_zone':
            if (!card.facedown) {
                card.visible = [];
                if (game_data.players) {
                    for (let player of game_data.players) {
                        card.visible.push(player.id);
                    }
                    for (let player of game_data.spectators) {
                        card.visible.push(player.id);
                    }
                }
            }
            break;
        case 'play':
            if (!card.facedown) {
                card.visible = [];
                if (game_data.players) {
                    for (let player of game_data.players) {
                        card.visible.push(player.id);
                    }
                    for (let player of game_data.spectators) {
                        card.visible.push(player.id);
                    }
                }
            }
            break;
    }
}

function fixVisibility(game_data) {
    for (let player of game_data.players) {
        for (let card of player.grave.cards) {
            setVisibility(card, 'grave', game_data);
        }
        for (let card of player.exile.cards) {
            setVisibility(card, 'exile', game_data);
        }
        for (let card of player.temp_zone.cards) {
            setVisibility(card, 'temp_zone', game_data);
        }
        for (let card of player.commander.cards) {
            setVisibility(card, 'commander', game_data);
        }
        for (let spot of player.playmat) {
            for (let card of spot.cards) {
                setVisibility(card, 'play', game_data);
            }
        }
    }
}

function nextTurn(game_data) {
    if(game_data != null) {
        if (game_data.type === 1 || game_data.type === 3 || game_data.type === 4 || game_data.type == 5) {
            let previous_turn = JSON.parse(JSON.stringify(game_data.current_turn));
            while (true) {
                game_data.current_turn ++;
                console.log(game_data.current_turn);
                if (game_data.current_turn > game_data.players[game_data.players.length - 1].turn) {
                    game_data.current_turn = 0;
                }
                if (game_data.current_turn === previous_turn) { //everyone has scooped, why are you ending the turn
                    console.log('bad');
                    break;
                }
                let good = false;
                for (let player of game_data.players) {
                    if (player.turn === game_data.current_turn) {
                        good = true;
                        break;
                    }
                }
                if (good) {
                    break;
                }
            }
            game_data.last_turn = new Date().getTime();
            messageConnectedUsers(game_data, JSON.parse(JSON.stringify({get: {turn_update: game_data.current_turn}})), null);
        }
        else if (game_data.type === 2) {
            let previous_turn = JSON.parse(JSON.stringify(game_data.current_turn));
            while (true) {
                game_data.current_turn ++;
                if (game_data.current_turn > game_data.team_data[game_data.team_data.length - 1].turn) {
                    game_data.current_turn = 0;
                }
                if (game_data.current_turn === previous_turn) { //everyone has scooped, why are you ending the turn
                    console.log('bad');
                    break;
                }
                let good = false;
                for (let team of game_data.team_data) {
                    if (team.turn === game_data.current_turn) {
                        if (team.scooped) {
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
            game_data.last_turn = new Date().getTime();
            messageConnectedUsers(game_data, JSON.stringify({get: {turn_update: game_data.current_turn}}), null);
        }
    }
}

function messageConnectedUsers(game_data, message_data, besides) {
    for (let user of game_data.connected) {
        if (besides != null) {
            if (user !== besides) {
                user.send(JSON.stringify(message_data));
            }
        }
        else {
            user.send(JSON.stringify(message_data));
        }
    }
}

wss.on("connection", ws => {
    connectedUsers.add(ws);
    console.log('client connected');
    ws.on("message", data => {
        let json_data = JSON.parse(data);
        let msg_content = json_data.content;
        if (msg_content.get) {
            if (msg_content.get.game) {
                if (msg_content.get.game === 'All') {
                    console.log('sending all games');
                    ws.send(JSON.stringify({get: {
                            game_data: {games: JSON.parse(JSON.stringify(games))}
                        }
                    }));
                }
                else {
                    let game_data = getGame(msg_content.game_id);
                    if (game_data) {
                        console.log('sending data for game ' + game_data.id);
                        ws.send(JSON.stringify(
                            {get: {game_data: game_data}}
                        ));
                    }
                    else {
                        console.log('game' + msg_content.get.game + 'not found')
                        ws.send(JSON.stringify({get:{game_data: {}}}));
                    }
                }
            }
        }
        if (msg_content.create) {
            createGame(msg_content.create.name, msg_content.create.type, msg_content.create.max_players).then((new_game) => {
                if (new_game && new_game.game_id) {
                    console.log('created game ' + new_game.game_id);
                    games.push({
                        id: new_game.game_id,
                        name: msg_content.create.name,
                        max_players: msg_content.create.max_players,
                        type: msg_content.create.type,
                        current_turn: 0,
                        turn_count: 0,
                        players: [],
                        spectators: [],
                        connected: [],
                        action_log: [],
                        last_modified: Date.now(),
                        started: new Date().getTime(),
                        last_turn: null,
                    });
                }
            });
        }
        if (msg_content.game_id) {
            if (msg_content.post) {
                if (msg_content.post.join) {
                    let game_data = getGame(msg_content.game_id);
                    if (game_data && !game_data.connected.includes(ws)) {
                        game_data.connected.push(ws);
                    }
                }
            }
            if (msg_content.put) { // put will be of the form {action, data}
                console.log('put request');
                if (msg_content.put.action) {
                    if (msg_content.put.action === 'start') {
                        let game_data = getGame(msg_content.game_id);
                        game_data.last_modified = Date.now();
                        if (game_data) {
                            startGame(game_data).then(() => {
                                if (game_data.type === game_types['two-headed']) {
                                    let team_data = [];
                                    for (let j = 0; j < msg_content.put.teams.length; j++) {
                                        team_data.push({
                                            team_id: j,
                                            turn: -1,
                                            life: 60,
                                            infect: 0,
                                            scooped: false,
                                            players: msg_content.put.teams[j],
                                        });
                                    }
                                    for (let i = 0; i < team_data.length; i++) {
                                        let r = i + Math.floor(Math.random() * (team_data.length - i));
                                        let temp = team_data[r];
                                        team_data[r] = team_data[i];
                                        team_data[i] = temp;
                                    }
                                    let play_order = [];
                                    for (let i = 0; i < team_data.length; i++) {
                                        play_order.push({ team_id: team_data[i].team_id, turn: i});
                                        team_data[i].turn = i;
                                    }
                                    game_data.current_turn = 0;
                                    game_data.turn_count = 1;
                                    game_data.team_data = team_data;
                                    for (let team of game_data.team_data) {
                                        if (team.players && team.players.length === 2) {
                                            getPlayer(team.players[0], game_data.players).teammate_id = team.players[1];
                                            getPlayer(team.players[0], game_data.players).hand_preview.push(team.players[1]);
                                            getPlayer(team.players[1], game_data.players).teammate_id = team.players[0];
                                            getPlayer(team.players[1], game_data.players).hand_preview.push(team.players[0]);
                                        }
                                    }
                                    console.log('started two headed');
                                    game_data.last_turn = new Date().getTime();
                                    messageConnectedUsers(game_data,{get: {game_data: JSON.parse(JSON.stringify(game_data))}}, null);
                                    backupGame(game_data);
                                }
                                else if (game_data.type === game_types['star']) {
                                    if (msg_content.put.colors) {
                                        for (let player of game_data.players) {
                                            for (let color of msg_content.put.colors) {
                                                if (color.id === player.id) {
                                                    player.star_color = color.star_color;
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                    console.log('starting game ' + game_data.id);
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
                                    game_data.current_turn = 0;
                                    console.log('got here');
                                    game_data.last_turn = new Date().getTime();
                                    messageConnectedUsers(game_data,
                                        JSON.parse(JSON.stringify({get: {game_data: game_data}})), null);
                                    backupGame(game_data);
                                }
                                else {
                                    console.log('starting game ' + game_data.id);
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
                                    game_data.current_turn = 0;
                                    console.log('got here');
                                    game_data.last_turn = new Date().getTime();
                                    messageConnectedUsers(game_data,
                                            JSON.parse(JSON.stringify({get: {game_data: game_data}})), null);
                                    backupGame(game_data);
                                }

                            });
                        }
                    }
                    if (msg_content.put.action === 'end_turn') {
                        let game_data = getGame(msg_content.game_id);
                        if (game_data) {
                            game_data.last_modified = Date.now();
                            nextTurn(game_data);
                        }
                    }
                    if (msg_content.put.action === 'end') {
                        let game_data = getGame(msg_content.game_id);
                        if (game_data) {
                            endGame(msg_content.put.winner, msg_content.put.winner_two, msg_content.game_id).then(() => {});
                        }
                    }
                    if (msg_content.put.action === 'update') {
                        console.log('got player update');
                        if (msg_content.put.player_data) {
                            let game_data = getGame(msg_content.game_id);
                            if (game_data && game_data.players != null) {
                                game_data.last_modified = Date.now();
                                console.log('getting player');
                                if (getPlayer(msg_content.put.player_data.id, game_data.players) != null) {
                                    console.log('player found')
                                    for (let i = 0; i < game_data.players.length; i++) {
                                        if (game_data.players[i].id === msg_content.put.player_data.id){
                                            game_data.players[i] = msg_content.put.player_data;
                                        }
                                    }
                                    messageConnectedUsers(game_data, {get: {player_data: msg_content.put.player_data}}, ws);
                                }
                                else {
                                    console.log('player not found, adding')
                                    if (game_data.turn_count === 0 && game_data.players.length < game_data.max_players) { //the game is in progress
                                        game_data.players.push(msg_content.put.player_data);
                                        console.log('player added')
                                        console.log('updating players')
                                        messageConnectedUsers(game_data, {get: {game_data: JSON.parse(JSON.stringify(game_data))}}, null);
                                    }
                                    else {
                                        game_data.spectators.push(msg_content.put.player_data);
                                        console.log('updating players')
                                        let spectator = msg_content.put.player_data;
                                        spectator.spectating = true;
                                        spectator.play_counters = [];
                                        fixVisibility(game_data);
                                        messageConnectedUsers(game_data, {get: {spectator_data: spectator}}, null);
                                    }
                                }
                            }
                        }
                        if (msg_content.put.team_data) {
                            let game_data = getGame(msg_content.game_id);
                            for (let i = 0; i < game_data.team_data.length; i++) {
                                if (game_data.team_data[i].id === msg_content.put.team_data.id) {
                                    console.log('found team to update');
                                    game_data.team_data[i] = msg_content.put.team_data;
                                    break;
                                }
                            }
                            messageConnectedUsers(game_data, {get: {team_data: msg_content.put.team_data}}, ws);
                        }
                        if (msg_content.put.zone_data) {
                            let game_data = getGame(msg_content.game_id);
                            if (game_data && game_data.players != null) {
                                game_data.last_modified = Date.now();
                                if (getPlayer(msg_content.put.zone_data.owner, game_data.players) != null) {
                                    switch(msg_content.put.zone_data.name) {
                                        case 'hand':
                                            getPlayer(msg_content.put.zone_data.owner, game_data.players).hand = msg_content.put.zone_data;
                                            break;
                                        case 'grave':
                                            getPlayer(msg_content.put.zone_data.owner, game_data.players).grave = msg_content.put.zone_data;
                                            break;
                                        case 'exile':
                                            getPlayer(msg_content.put.zone_data.owner, game_data.players).exile = msg_content.put.zone_data;
                                            break;
                                        case 'temp_zone':
                                            getPlayer(msg_content.put.zone_data.owner, game_data.players).temp_zone = msg_content.put.zone_data;
                                            break;
                                        case 'deck':
                                            getPlayer(msg_content.put.zone_data.owner, game_data.players).deck = msg_content.put.zone_data;
                                            break;
                                        case getPlayer(msg_content.put.zone_data.owner, game_data.players).deck.name:
                                            getPlayer(msg_content.put.zone_data.owner, game_data.players).deck = msg_content.put.zone_data;
                                            break;
                                    }
                                    messageConnectedUsers(game_data, {get: {zone_data: msg_content.put.zone_data}}, ws);
                                }
                            }
                        }
                        if (msg_content.put.plane_data) {
                            let game_data = getGame(msg_content.game_id);
                            if (game_data) {
                                console.log('got plane');
                                game_data.last_modified = Date.now();
                                game_data.current_plane = msg_content.put.plane_data;
                                messageConnectedUsers(game_data, {get: {plane_data: msg_content.put.plane_data}}, ws);
                            }
                        }
                    }
                    if (msg_content.put.action === 'shake') {
                        let game_data = getGame(msg_content.game_id);
                        game_data.last_modified = Date.now();
                        if (msg_content.put.card) {
                            messageConnectedUsers(game_data,
                                {get:
                                        {shake_data: {card: msg_content.put.card, id: msg_content.put.id, location: msg_content.put.location}}}, ws);
                        }
                    }
                    if (msg_content.put.action === 'random') {
                        let game_data = getGame(msg_content.game_id);
                        game_data.last_modified = Date.now();
                    }
                    if (msg_content.put.action === 'scoop') {
                        let game_data = getGame(msg_content.game_id);
                        if (game_data && game_data.players != null) {
                            game_data.last_modified = Date.now();
                            let bad_turn = false;
                            if (game_data.type !== 2) {
                                if (msg_content.put.player_data.turn === game_data.current_turn) {
                                    bad_turn = true;
                                }
                                let spectator = {
                                    id: msg_content.put.player_data.id,
                                    name: msg_content.put.player_data.name,
                                    spectating: true,
                                    play_counters: []
                                }
                                let ind = -1;
                                for (let i = 0; i < game_data.players.length; i++) {
                                    if (game_data.players[i].id === msg_content.put.player_data.id) {
                                        ind = i;
                                        break;
                                    }
                                }
                                if(ind > -1) {
                                    game_data.players.splice(ind, 1);
                                }
                                game_data.spectators.push(spectator);
                                messageConnectedUsers(game_data, {get: {scoop_data: spectator}}, ws);
                                if (bad_turn) {
                                    nextTurn();
                                }
                            }
                            else {
                                let team = getTeam(msg_content.put.player_data.id);
                                if (team.turn === game_data.current_turn) {
                                    bad_turn = true;
                                }
                                let new_spectators = []
                                for (let player of team) {
                                    new_spectators.push(
                                        {
                                            id: player,
                                            name: getPlayer(player, game_data.players).name,
                                            spectating: true,
                                            play_counters: []
                                        }
                                    );
                                }
                                for (let player of team) {
                                    let ind = -1;
                                    for (let i = 0; i < game_data.players.length; i++) {
                                        if (game_data.players[i].id === player) {
                                            ind = i;
                                            break;
                                        }
                                    }
                                    if(ind > -1) {
                                        game_data.players.splice(ind, 1);
                                    }
                                }
                                for (let spectator of new_spectators) {
                                    game_data.spectators.push(spectator);
                                    messageConnectedUsers(game_data, {get: {scoop_data: spectator}}, ws);
                                }
                                if (bad_turn) {
                                    nextTurn();
                                }
                            }
                        }
                    }
                }
            }
            if (msg_content.log) {
                let game_data = getGame(msg_content.game_id);
                if (game_data) {
                    game_data.action_log.push(msg_content.log);
                    messageConnectedUsers(game_data, {log: msg_content.log}, ws);
                }
            }
            if (msg_content.ping) {
                console.log('pong');
                ws.send(JSON.stringify({pong: true}));
            }
        }
    });


    ws.on("close", () => {
        console.log('client disconnected');
        for (let game of games) {
            if (game.connected && game.connected.includes(ws)) {
                game.connected.splice(game.connected.indexOf(ws), 1);
            }
        }
        connectedUsers.delete(ws);
    });

    ws.onerror = function () {
        console.log("error occured");
    }
});
console.log("Loading old games from the db");
getGameTypes().then(() => {console.log('loaded game types');});
getActiveGames().then((game_data) => {
    if (game_data != null && game_data.length > 0) {
        for (let game of game_data) {
            if (game.game_data != null) {
                let temp_game = JSON.parse(game.game_data);
                temp_game.connected = [];
                games.push(temp_game);
                console.log('loaded game ' + game.id);
            }
            else {
                endGame(null, null, game.id);
                console.log('closed game ' + game.id);
            }
        }
    }
});

setInterval(backupGames, 60000);

console.log("Websocket running on port 8191");

