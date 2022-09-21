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
            [JSON.stringify(game), game.id],
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

wss.on("connection", ws => {
    console.log("new client connected");
    connectedUsers.add(ws);

    ws.on("message", data => {
        let json_data = JSON.parse(data);
        let msg_content = json_data.content;
        if (msg_content.create) { //Create a game instance
            createGame(msg_content.create.name, msg_content.create.type, msg_content.create.max_players).then((new_game) => {
                if (new_game && new_game.game_id) {
                    console.log('created game');
                    games.push({
                        id: new_game.game_id,
                        name: msg_content.create.name,
                        max_players: msg_content.create.max_players,
                        type: msg_content.create.type,
                        current_turn: 0,
                        turn_count: 0,
                        players: [],
                        action_log: [],
                        last_modified: Date.now()
                    });
                    let game_data = getGame(new_game.game_id);
                    if (msg_content.create.type === game_types['commander']) {
                        game_data.action_log.push('Game created with type: commander.');
                        console.log('Game created with type: commander.');
                    }
                    else if (msg_content.create.type === game_types['star']) {
                        game_data.action_log.push('Game created with type: star.');
                        console.log('Game created with type: star.');
                    }
                    else if (msg_content.create.type === game_types['two-headed']) {
                        game_data.action_log.push('Game created with type: two-headed.');
                        console.log('Game created with type: two-headed.');
                    }
                    else {
                        console.log('could not get game type.');
                    }
                    console.log('game added to list.');
                }
            });
            //connectedUsers.broadcast(JSON.stringify(games));
        }
        else if (msg_content.start) { //figure out turns and start the game
            if (msg_content.game_id) {
                let game_data = getGame(msg_content.game_id);
                game_data.last_modified = Date.now();
                game_data.action_log.push('Starting the game.');
                console.log('starting the game.');
                if (game_data) {
                    startGame(game_data).then(() => {
                        if (game_data.type === game_types['commander'] || game_data.type === game_types['star']) {
                            if (game_data.type === game_types['commander']) {
                                console.log('Game started with type: commander.');
                                game_data.action_log.push('Game started with type: commander.');
                            }
                            else if (game_data.type === game_types['star']) {
                                console.log('Game started with type: star.');
                                game_data.action_log.push('Game started with type: star.');
                            }
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
                            game_data.action_log.push('Players shuffled and turn order created.');
                            connectedUsers.broadcast(JSON.stringify({play_order: play_order}), 4);
                            backupGame(game_data);
                        }
                        else if (game_data.type === game_types['two-headed']) {
                            if (msg_content.teams && msg_content.teams.length > 0) {
                                console.log('Game started with type: two-headed.');
                                game_data.action_log.push('Game started with type: two-headed.');
                                let team_data = [];
                                for (let j = 0; j < msg_content.teams.length; j++) {
                                    team_data.push({
                                        team_id: j,
                                        turn: -1,
                                        life: 60,
                                        infect: 0,
                                        scooped: false,
                                        players: msg_content.teams[j],
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
                                game_data.turn_count = 1;
                                console.log(play_order);
                                game_data.team_data = team_data;
                                for (let team of game_data.team_data) {
                                   if (team.players && team.players.length === 2) {
                                       getPlayer(team.players[0], game_data.players).teammate_id = team.players[1];
                                       getPlayer(team.players[0], game_data.players).hand_preview.push(team.players[1]);
                                       getPlayer(team.players[1], game_data.players).teammate_id = team.players[0];
                                       getPlayer(team.players[1], game_data.players).hand_preview.push(team.players[0]);
                                   }
                                }
                                game_data.action_log.push('Teams shuffled and turn order created.')
                                connectedUsers.broadcast(JSON.stringify({game_data: game_data}), 4);
                                backupGame(game_data);
                            }
                            else {
                                console.log('Missing teams, cannot start');
                            }
                        }
                    });
                }
            }
        }
        else if (msg_content.end) {
            if (msg_content.game_id) {
                console.log('ending the game');
                let game_data = getGame(msg_content.game_id);
                if (game_data) {
                    endGame(msg_content.winner, msg_content.winner_two, msg_content.game_id).then(() => {
                    });
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
                    if (game_data && game_data.players != null) {
                        game_data.last_modified = Date.now();
                        if (msg_content.message) {
                            game_data.action_log.push(msg_content.message);
                        }
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
                    if (game_data && game_data.players != null) {
                        if (msg_content.message) {
                            game_data.action_log.push(msg_content.message);
                        }
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
            }
            else if (msg_content.request === 'team_change') {
                if (msg_content.game_id && msg_content.team_data) {
                    console.log('got team data request');
                    let game_data = getGame(msg_content.game_id);
                    if (game_data && game_data.team_data != null) {
                        if (msg_content.message) {
                            game_data.action_log.push(msg_content.message);
                        }
                        for (let i = 0; i < game_data.team_data.length; i++) {
                            if (game_data.team_data[i].id === msg_content.team_data.id) {
                                console.log('found team to update');
                                game_data.team_data[i] = msg_content.team_data;
                                break;
                            }
                        }
                        connectedUsers.broadcast(JSON.stringify({team_data: msg_content.team_data}), ws);
                    }
                }
            }
            else if (msg_content.request === 'end_turn') {
                console.log('ending turn');
                let game_data = getGame(msg_content.game_id);
                if (game_data) {
                    game_data.last_modified = Date.now();
                    if (msg_content.message) {
                        game_data.action_log.push(msg_content.message);
                    }
                    let previous_turn = JSON.parse(JSON.stringify(game_data.current_turn));
                    if (game_data.type === 1 || game_data.type === 3) {
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
                    else if (game_data.type === 2) {
                        while (true) {
                            game_data.current_turn ++;
                            if (game_data.current_turn > game_data.team_data.length - 1) {
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
                        connectedUsers.broadcast(JSON.stringify({turn_data: {turn_count: game_data.turn_count, current_turn: game_data.current_turn}}), 4);
                    }
                }
            }
            else if (msg_content.request === 'shake') {
                let game_data = getGame(msg_content.game_id);
                game_data.last_modified = Date.now();
                if (msg_content.message) {
                    game_data.action_log.push(msg_content.message);
                }
                if (msg_content.card) {
                    connectedUsers.broadcast(JSON.stringify({shake_data: {cardid: msg_content.card.id, userid: msg_content.card.user, location: msg_content.card.location}}), ws);
                }
            }
            else if (msg_content.request === 'select_random') {
                let game_data = getGame(msg_content.game_id);
                game_data.last_modified = Date.now();
                if (msg_content.message) {
                    game_data.action_log.push(msg_content.message);
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
console.log("Loading old games from the db");
getGameTypes().then(() => {console.log('loaded game types');});
getActiveGames().then((game_data) => {
    if (game_data != null && game_data.length > 0) {
        for (let game of game_data) {
            if (game.game_data != null) {
                games.push(JSON.parse(game.game_data));
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

