import DatabaseHandler from './database_handler.js';
import * as fs from 'fs';

function parse_arguments() {
    let users = [];
    process.argv.shift();
    while(!fs.lstatSync(process.argv.shift()).isFile()) {}
    for(const user of process.argv) {
        users.push(user);
    }
    if(users.length === 0) {
        throw Error(
            "Please add some telegram user chat Ids, names, and admin " +
            "statuses as input parameters"
        );
    }
    if(users.length % 3 !== 0) {
        throw Error(
            "Please add an equal amount of alternating telegram user chat " +
            "Ids, names, and admin statuses as input parameters"
        );
    }
    for(let i = 0; i < users.length; i++) {
        if(!/^\d+$/.test(users[i++])) {
            throw Error(
                `Error: Chat Id '${users[i - 1]}' is not a number`
            );
        }
        i++;
    }
    return users;
}  

async function main(users: string[]) {
    const db = new DatabaseHandler("data.sqlite", true);
    await db.createDatabase();
    await db.createTable(
        "users",
        'chat_id INTEGER PRIMARY KEY, ' +
        'name TEXT, ' +
        'admin INTEGER DEFAULT FALSE, ' +
        'blocked INTEGER DEFAULT TRUE, ' +
        'pending INTEGER DEFAULT TRUE, ' +
        'request_sent INTEGER DEFAULT FALSE'
    );
    await db.createTable(
        "routes",
        'chat_id INTEGER NOT NULL, ' +
        'route TEXT NOT NULL, ' +
        'day TEXT NOT NULL, ' +
        'seats INTEGER DEFAULT TRUE'
    );
    let data: any[][] = [['chat_id', 'name', 'admin', 'blocked', 'pending']];
    for(let i = 0; i < users.length; i++) {
        data.push([
            users[i],
            `'${users[++i]}'`,
            users[++i].toLowerCase() === "true" ? true : false,
            false,
            false
        ]);
    }
    await db.insertData('users', data);
    console.log(
        `Database created successfully!\nAdded user(s) ${users.join(', ')}`
    );
    const check_users = await db.query("SELECT * FROM users;")
    console.log("Users in database:", check_users);
    await db.close();
}

main(parse_arguments());
