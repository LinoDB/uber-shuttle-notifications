import * as https from 'https';
import * as zlib from 'zlib';
import * as fs from 'fs';
import type { IncomingMessage } from 'http';
import DatabaseHandler from './database_handler.js';
import { globSync } from 'glob';
import sqlite3 from 'sqlite3';

interface Schedule {
    day: string,
    seatsAvailable: string
}


class Shuttle {
    #cookies_paths: string[];
    #telegram_bot: string;
    #refresh_rate: number;
    #cookies: any;
    #secret: string;
    verbose: boolean;
    #set_webhook: boolean;
    #delete_webhook: boolean;
    db: typeof sqlite3.Database;
    #timers = {};
    #webhook_data = {
        max_connections: "100",
        allowed_updates: ["message"],
        drop_pending_updates: "True",
    };
    #telegram_options = {
        hostname: 'api.telegram.org',
        port: 443,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': null,
          Connection: "keep-alive",
        }
    };
    message_options: any;
    fetch_options = {
        hostname: 'm.uber.com',
        port: 443,
        path: '/go/graphql',
        method: 'POST',
        // timeout: 3000,
        headers: {
            Accept: "*/*",
            'Accept-Encoding': "gzip", // , deflate, br, zstd
            'Content-Type': "application/json",
            Referer: "https://m.uber.com/",
            'x-csrf-token': "x",
            Origin: "https://m.uber.com",
            'Sec-Fetch-Dest': "empty",
            'Sec-Fetch-Mode': "cors",
            'Sec-Fetch-Site': "same-origin",
            'Sec-Fetch-User': "?1",
            Connection: "keep-alive",
            'Alt-Used': "m.uber.com",
            TE: "trailers",
        }
    };
    #destinations: any;
    schedules = {};
    weekdays_index = {
        Monday: 1,
        Tuesday: 2,
        Wednesday: 3,
        Thursday: 4,
        Friday: 5,
    };
    index_weekdays = {
        1: 'Monday',
        2: 'Tuesday',
        3: 'Wednesday',
        4: 'Thursday',
        5: 'Friday',
    };

    constructor(
        telegram_bot: string,
        cookies_path: string = null,
        refresh_rate: number = 5.0,
        verbose: boolean = false,
        set_webhook: string = null,
        delete_webhook: boolean = false,
        secret: string = null
    ) {
        this.#telegram_bot = telegram_bot;
        this.#cookies_paths = this.#get_cookie_paths(cookies_path);
        this.#refresh_rate = refresh_rate;
        this.verbose = verbose;
        this.#set_webhook = set_webhook ? true : false;
        this.#webhook_data["url"] = set_webhook;
        this.#secret = secret;
        if(secret) {
            this.#webhook_data["secret_token"] = secret;
        }
        this.#delete_webhook = delete_webhook;
        this.message_options = {
            hostname: 'api.telegram.org',
            port: 443,
            path: `/bot${this.#telegram_bot}/sendMessage`,
            method: 'POST',
            // timeout: 3000,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': null,
              Connection: "keep-alive",
            }
        }
    }

    static helper_split(str: string, pattern: string) {
        if(str.includes(pattern)) {
            return str.split(pattern);
        }
        return [str];
    }

    static capitalize(str: string) {
        return str.slice(0, 1).toUpperCase() + str.slice(1);
    }

    log(msg: string) {
        if(this.verbose) {
            console.log(msg);
        }
    }

    warn(msg: string) {
        if(this.verbose) {
            console.warn(msg);
        }
    }

    error(msg: string) {
        if(this.verbose) {
            console.error(msg);
        }
    }

    async initialize() {
        await this.#load_cookies();
        await this.#load_destinations();
        await this.#confirm_access();
        if(this.#set_webhook) {
            await this.set_webhook();
        }
        if(this.verbose) {
            console.log(
                "Initialized 'Shuttle' instance with refresh rate " +
                this.#refresh_rate +
                (
                    this.#secret ?
                    ` and telegram secret ${this.#secret}` :
                    " and without telegram secret"
                )
            );
        }
        this.db = new DatabaseHandler('data.sqlite');
        await this.db.open();
        const routes = await this.db.query(
            "SELECT DISTINCT route FROM routes;"
        );
        this.notify_all("*Service has started!*", this);
        for(const route of routes) {
            await this.#initialize_route(route.route);
            this.check_new_seats(
                this.schedules[route.route], route.route, this, true
            );
        }
        setInterval(this.#route_cleanup, 24 * 60 * 60 * 1000, this);
        console.info(`Current time: ${new Date()}`);
    }

    async shutdown(error_code: 0 | 1) {
        let msg: string;
        switch(error_code) {
            case 0:
                msg = "*Service has been shut down!*";
                break;
            case 1:
                msg = "*Service has crashed!*";
                break;
            default:
                msg = "*Service has stopped!*";
        }
        for(const route in this.#timers) {
            delete this.#timers[route];
        }
        if(this.#delete_webhook) {
            try {
                await this.delete_webhook();
            }
            catch(e) {
                console.error(`Deleting webhook failed with ${e}`);
            }
        }
        await this.notify_all(msg, this);
        try {
            await this.db.close();
        }
        catch(e) {
            `Error while closing database: ${e}`
        }
    }

    async fetch_loop() {
        await this.delete_webhook();
        let current_offset = 0;
        let update_options = {...this.#telegram_options};
        update_options['path'] = `/bot${this.#telegram_bot}/getUpdates`;
        update_options.headers = {...this.#telegram_options.headers};
        while(true) {
            const data = JSON.stringify({
                allowed_updates: ["message"],
                timeout: 3,
                offset: current_offset
            });
            update_options.headers['Content-Length'] = data.length;
            try {
                const fetch: string = await new Promise((resolve, reject) => {
                    let request = https.request(
                        update_options,
                        (res: IncomingMessage) => {
                            let body = '';
                            res.on('error', (e: Error) => {
                                reject(e);
                            });
                            res.on('data', (chunk: any) => {
                                body += chunk.toString();
                            });
                            res.on('end', () => {
                                resolve(body);
                            });
                        }
                    );
                
                    request.on('error', (e: Error) => {
                        reject(e);
                    });
                
                    request.write(data);
                    request.end();
                });
                let updates = JSON.parse(fetch).result;
                for(const update of updates) {
                    this.process_request(
                        update.message.chat.id,
                        update.message.text,
                        update.message.chat.first_name
                    );
                    current_offset = ++update.update_id;
                }
            }
            catch(e) {
                this.error(`Error while fetching data: ${e}`);
            }
        }
    }

    #get_cookie_paths(cookies_path: string): string[] {
        if(cookies_path) {
            return [cookies_path];
        }
        let paths: string[];
        if(process.env.APPDATA) {
            paths = globSync(`${process.env.APPDATA}/Mozilla/Firefox/Profiles/*default*/cookies.sqlite`);
        }
        else if(process.env.HOME){
            paths = globSync(`${process.env.HOME}/snap/firefox/common/.mozilla/firefox/*default*/cookies.sqlite`);
        }
        else {
            throw Error(
                "Couldn't find home directory, please provide the " +
                "Firefox cookie database path using the '-c' parameter");
        }
        if(paths.length === 0) {
            throw Error(
                "Couldn't find Firefox cookie database path, " +
                "please provide it using the '-c' parameter"
            );
        }
        return paths;
    }

    async #load_cookies(): Promise<undefined> {
        this.#cookies = '';
        const host_names = ["'.uber.com'", "'.m.uber.com'", "'m.uber.com'"];
        for(const path of this.#cookies_paths) {
            const db = new DatabaseHandler(path);
            try {
                await db.open();
                const rows = await db.query(
                    'SELECT name, value FROM moz_cookies WHERE host ' +
                    `IN (${host_names.join(', ')});`
                );
                await db.close();
                for(const row of rows) {
                    this.#cookies += `${row.name}=${row.value};`;
                }
                this.fetch_options.headers["cookie"] = this.#cookies;
                return;
            }
            catch(e) {
                console.warn(
                    `While reading the cookies from database '${path}', the ` +
                    `following error occurred: ${e}`
                )
                this.#cookies = '';
            }
        }
        throw Error(
            "Couldn't find the uber cookies in paths " +
            `'${this.#cookies_paths.join("', '")}'`
        );
    }

    async #load_destinations() {
        try {
            await new Promise((resolve, reject) => {
                fs.readFile('./destinations.json', 'utf8', (error, buffer) => {
                    if(error) {
                        reject(error)
                        return;
                    }
                    this.#destinations = JSON.parse(buffer);
                    if(!this.#destinations['Work']) {
                        reject("The destination 'Work' must always be defined");
                        return;
                    }
                    if(Object.keys(this.#destinations).length < 2) {
                        reject(
                            'Please define at least one destination other ' +
                            "than 'Work'"
                        );
                        return;
                    }
                    resolve(true);
                });
            });
        }
        catch(e) {
            throw `Error reading destinations from './destinations.json': ${e}`
        }
    }

    async #confirm_access() {
        let response: any;
        let any_dest: string;
        for(const key of Object.keys(this.#destinations)) {
            if(key !== 'Work') {
                any_dest = key;
                break;
            }
        }
        const fetch = await this.fetch_updates('Work', any_dest, this);
        try{
            response = JSON.parse(fetch);
        }
        catch(e) {
            throw (
                `'${e}' occurred while parsing response:\n${fetch}\n` +
                'Please navigate to https://m.uber.com/ to update cookies!'
            );
        }
        if(!response.data && response.errors) {
            if(response.errors[0]['message'] === 'unauthorized') {
                throw Error(
                    'It seems like there is no active session, please ' +
                    'log in on https://m.uber.com/'
                );
            }
            else {
                throw Error(
                    'An unknown error uccurred while trying to reach the ' +
                    `uber endpoint: ${response.errors[0]['message']}`
                );
            }
        }
    }

    set_webhook(): Promise<any> {
        const data = JSON.stringify(this.#webhook_data);
        let webhook_options = {...this.#telegram_options};
        webhook_options['path'] = `/bot${this.#telegram_bot}/setWebhook`;
        webhook_options.headers = {...this.#telegram_options.headers};
        webhook_options.headers['Content-Length'] = data.length;
        return new Promise((resolve, reject) => {
            const request = https.request(
                webhook_options,
                (res: IncomingMessage) => {
                    let body = '';
                    res.on('error', (e: Error) => {
                        reject(e);
                    });
                    res.on('data', (chunk: any) => {
                        body += chunk.toString();
                    });
                    res.on('end', () => {
                        const result = JSON.parse(body);
                        if(result.result) {
                            console.log("Webhook was set successfully");
                            resolve(true);
                        }
                        else {
                            reject(
                                `Webhook couldn't be set properly: ${body}`
                            );
                        }
                    });
                }
            );
          
            request.on('error', (e: Error) => {
                reject(e);
            });
        
            request.write(data);
            request.end();
        });
    }

    delete_webhook(): Promise<string> {
        const data = JSON.stringify({drop_pending_updates: "True"});
        let webhook_options = {...this.#telegram_options};
        webhook_options['path'] = `/bot${this.#telegram_bot}/deleteWebhook`;
        webhook_options.headers = {...this.#telegram_options.headers};
        webhook_options.headers['Content-Length'] = data.length;
        return new Promise((resolve, reject) => {
            let request = https.request(
                webhook_options,
                (res: IncomingMessage) => {
                    let body = '';
                    res.on('error', (e: Error) => {
                        reject(e);
                    });
                    res.on('data', (chunk: any) => {
                        body += chunk.toString();
                    });
                    res.on('end', () => {
                        const result = JSON.parse(body);
                        if(result.result) {
                            console.log("Webhook was successfully deleted");
                            resolve("Webhook was successfully deleted");
                        }
                        else {
                            console.error(
                                `Webhook couldn't be deleted properly: ${body}`
                            );
                            resolve(
                                `Webhook couldn't be deleted properly: ${body}`
                            );
                        }
                    });
                }
            );
          
            request.on('error', (e: Error) => {
                reject(e);
            });
        
            request.write(data);
            request.end();
        });
    }

    test_secret(secret: string) {
        if(this.#secret) {
            return secret === this.#secret ? true : false;
        }
        return true;
    }

    #route_cleanup(instance: Shuttle) {
        const due_date = new Date();
        due_date.setDate(-14);
        for(const route in instance.schedules) {
            for(const date in instance.schedules[route]) {
                if(due_date > instance.schedules[route][date]["added"]) {
                    delete instance.schedules[route][date];
                }
            }
        }
    }

    async #check_user(chat_id: string, name: string): Promise<boolean[]> {
        const res = await this.db.query(
            `SELECT blocked, pending FROM users WHERE chat_id = ${chat_id};`
        );
        if(res.length === 0) {
            await this.db.insertData('users', [
                ['chat_id', 'name'],
                [chat_id, `'${name}'`],
            ]);
            this.send_notification(
                "Welcome! To use the *Uber Shuttle Notification* service, " +
                "you need to be added first. Send a message with _join_ to " +
                "notify admins.\nDisclaimer: Admins will be able to see your " +
                "user name and user Id.",
                chat_id,
                this
            );
            return [true, true];
        }
        else {
            return [res[0].blocked, res[0].pending];
        }
    }

    async #notify_request(chat_id: string, name: string) {
        await this.db.update(
            'users', 'request_sent = TRUE', `chat_id = ${chat_id}`
        );
        const msg = (
            `New user ${chat_id} (${name}) requests to join the user ` +
            `group.\n\nTo add, send:\n_admin add ${chat_id}_\n` +
            `To make admin, send:\n_admin admin ${chat_id}_\n` +
            `To block, send:\n_admin block ${chat_id}_`
        );
        this.#notify_admins(msg);
        this.send_notification("Admins have been notified", chat_id, this);
    }

    async #notify_admins(msg: string, except: string = null) {
        let admins = await this.db.query(
            'SELECT chat_id FROM users WHERE admin = TRUE' +
            (except ? ` AND chat_id != ${except};` : ';')
        );
        for(const adm of admins) {
            this.send_notification(msg, adm.chat_id, this);               
        }
    }

    async process_request(
        chat_id_raw: string | number, request: string, name: string
    ) {
        if(
            (chat_id_raw === undefined) ||
            (request === undefined) ||
            (name === undefined)
        ) {
            return;
        }
        const chat_id = '' + chat_id_raw;
        let blocked: boolean, pending: boolean;
        [blocked, pending] = await this.#check_user(chat_id, name);
        let request_arr = [];
        for(const req of Shuttle.helper_split(request.toLowerCase(), ' ')) {
            const val = req.trim();
            if(val.length > 0) {
                request_arr.push(val);
            }
        }
        const cmd = request_arr.shift().replace('/', '');
        if(cmd === 'join') {
            if(pending) {
                this.#notify_request(chat_id, name);
            }
            return;
        }
        if(blocked) {
            return;
        }
        switch(cmd) {
            case "add":
                this.#request_add(chat_id, request_arr);
                break;
            case "stop":
                this.#request_stop(chat_id, request_arr);
                break;
            case "stopall":
                this.#request_stop(chat_id, ['all']);
                break;
            case "info":
                this.#request_info(chat_id);
                break;
            case "status":
                this.#request_status(chat_id);
                break;
            case "help":
                this.#request_help(chat_id);
                break;
            case "admin":
                this.#admin_request(chat_id, request_arr);
                break;
            default:
                this.#invalid_request(chat_id, cmd);
        }
    }

    #parse_routes(route: string) {
        let route_check = Shuttle.helper_split(route, '-');
        route_check = route_check.map((r: string) => Shuttle.capitalize(r));
        if(
            route_check.length === 1
            && this.#destinations[route_check[0]]
        ) {
            return [`${route_check[0]}-Work`, `Work-${route_check[0]}`];
        }
        if(route_check.length === 2) {
            if(this.#destinations[route_check[0]]) {
                return [`${route_check[0]}-Work`];
            }
            else if(this.#destinations[route_check[1]]) {
                return [`Work-${route_check[1]}`];
            }
        }
        return [];
    }

    async #request_add(
        chat_id: string,
        request_arr: string[]
    ): Promise<undefined> {
        if(request_arr.length ===  0) {
            this.send_notification(
                'Please enter a route parameter. ' +
                'Type _help_ to see the instructions.',
                chat_id,
                this
            );
            return;
        }
        const route_request = request_arr.shift();
        const routes_arr = Shuttle.helper_split(route_request, ',');
        let routes = [];
        for(const rout_arr of routes_arr) {
            routes = routes.concat(this.#parse_routes(rout_arr));
        }
        if(routes.length ===  0) {
            this.send_notification(
                `*Error:* Couldn't find route '${route_request}'`, chat_id, this
            );
            return;
        }
        let days = Object.keys(this.weekdays_index);
        let seats = true;
        while(request_arr.length > 0) {
            let param = request_arr.shift();
            if(param.startsWith('days=')) {
                param = param.slice(5);
                let param_arr = Shuttle.helper_split(param, ',');
                param_arr = param_arr.map((p: string) => Shuttle.capitalize(p));
                for(const par of param_arr) {
                    if(!Object.keys(this.weekdays_index).includes(par)) {
                        this.send_notification(
                            `*Error:* Unknown day parameter ${par}`,
                            chat_id,
                            this
                        );
                        return;
                    }
                }
                days = param_arr;
            }
            if(param.startsWith('seats=')) {
                param = param.slice(6);
                if(param !== "true" && param !== "false") {
                    this.send_notification(
                        `*Error:* Unknown seats parameter ${param}`,
                        chat_id,
                        this
                    );
                    return;
                }
                seats = param === 'true' ? true : false;
            }
        }
        let msg = [];
        const current = await this.db.query(
            'SELECT DISTINCT chat_id, route FROM routes WHERE ' +
            `chat_id = ${chat_id} AND route IN ('${routes.join("', '")}');`
        );
        let route_arr = {};
        for(const curr of current) {
            route_arr[curr.route] = true;
        }
        for(const route of routes) {
            if(route_arr[route]) {
                msg.push(`Updated route ${route}`);
            }
            else {
                msg.push(`Subscribed to route ${route}`);
            }
            await this.subscribe_to_route(route, chat_id, days, seats);
        }
        let already_available = ['']
        if(seats) {
            for(const route of routes) {
                if(this.schedules[route]) {
                    for(const day in this.schedules[route]) {
                        if(this.schedules[route][day]["seats"] != 0) {
                            const weekday = Shuttle.helper_split(day, ' ')[0];
                            if(days.includes(weekday)) {
                                already_available.push(
                                    `*${route}*\n` +
                                    this.schedules[route][day]["seats"] +
                                    ` Seats are already available for ${day}`
                                );
                            }
                        }
                    }
                }
            }
        }
        if(already_available.length > 1 ){
            msg = msg.concat(already_available);
        }
        this.send_notification(msg.join('\n'), chat_id, this);
    }

    async #request_stop(chat_id: string, request_arr: string[]) {
        if(request_arr.length ===  0) {
            this.send_notification(
                "Please enter a route parameter or 'all'. " +
                "Type _help_ to see the instructions.",
                chat_id,
                this
            );
            return;
        }
        const route_request = request_arr.shift();
        let routes: string[] = [];
        let current = await this.db.query(
            `SELECT DISTINCT route FROM routes WHERE chat_id = ${chat_id};`
        );
        current = current.map((route: any) => route.route);
        if(route_request.toLowerCase() === 'all') {
            if(current.length ===  0) {
                this.send_notification(
                    `There are no current subscriptions`, chat_id, this
                );
                return;
            }
            routes = current;
        }
        else {
            let routes_arr = Shuttle.helper_split(route_request, ',');
            for(const rout_arr of routes_arr) {
                routes = routes.concat(this.#parse_routes(rout_arr));
            }
            if(routes.length ===  0) {
                this.send_notification(
                    `*Error:* Couldn't find route ${route_request}`,
                    chat_id,
                    this
                );
                return;
            }
        }

        let msg = [];
        for(const route of routes) {
            const unsubscribed = await this.unsubscribe_from_route(
                route, chat_id
            );
            msg.push(`*${route}*: ${unsubscribed[1]}`);
        }
        await this.db.deleteRows(
            'routes',
            `chat_id = ${chat_id} AND route IN ('${routes.join("', '")}');`
        );
        this.send_notification(msg.join('\n'), chat_id, this);
        let remaining = await this.db.query(
            "SELECT DISTINCT route FROM routes;"
        );
        remaining = remaining.map((route: any) => route.route);
        for(const route of routes) {
            if(!remaining.includes(route)) {
                clearInterval(this.#timers[route]);
                delete this.#timers[route];
            }
        }
    }

    async #request_info(chat_id: string) {
        let user_subscriptions = [];
        let routes = {};
        let current = await this.db.query(
            'SELECT DISTINCT route, day, seats FROM routes WHERE ' +
            `chat_id = ${chat_id};`
        );
        for(const curr of current) {
            if(routes[curr.route]) {
                routes[curr.route]['days'].push(curr.day);
            }
            else {
                routes[curr.route] = {
                    days: [curr.day],
                    seats: curr.seats ?  "True" : "False",
                };
            }
        }
        for(const route in routes) {
            user_subscriptions.push(
                `*${route}*\ndays: [${routes[route]['days'].join(', ')}], ` +
                `notify for free seats: ${routes[route]['seats']}`
            );
        }
        if(user_subscriptions.length === 0) {
            this.send_notification(
                'You have no notification subscriptions', chat_id, this
            );
        }
        else {
            this.send_notification(
                'These are your notification subscriptions:\n\n' +
                user_subscriptions.join('\n'),
                chat_id,
                this
            );
        }
    }

    async #request_status(chat_id: string) {
        let route_subscriptions = [];
        const current = await this.db.query(
            "SELECT route, COUNT(DISTINCT chat_id) AS subs FROM routes " +
            "GROUP BY route;"
        );
        for(const curr of current) {
            route_subscriptions.push(
                `*${curr.route}:* ${curr.subs} subscriptions`
            );
        }
        if(route_subscriptions.length === 0) {
            this.send_notification(
                'There are no notification subscriptions at the moment',
                chat_id,
                this
            );
        }
        else {
            this.send_notification(
                'These are all the notification subscriptions per route:\n\n' +
                route_subscriptions.join('\n'),
                chat_id,
                this
            );
        }
    }

    async #admin_get_users(chat_id: string) {
        const current = await this.db.query(
            'SELECT COUNT(chat_id) AS users, SUM(pending) AS pending, ' +
            'SUM(blocked) AS blocked, SUM(request_sent) AS request_sent, ' +
            'SUM(admin) AS admins FROM users;'
        );
        this.send_notification(
            `*${current[0].users - current[0].blocked}* current users.\n` +
            `*${current[0].pending}* opened the chat.\n` +
            `*${current[0].request_sent}* sent a request.\n` +
            `*${current[0].blocked - current[0].pending}* users were ` +
            'blocked.\n' +
            `*${current[0].admins}* current admins.`,
            chat_id,
            this
        );
    }

    async #admin_get_requests(chat_id: string) {
        const current = await this.db.query(
            'SELECT chat_id, name FROM users WHERE request_sent = TRUE;'
        );
        if(current.length === 0) {
            this.send_notification(
                'There are no pending requests', chat_id, this
            );
            return;
        }
        const users = ["Requests received:"];
        for(const curr of current) {
            users.push(`${curr.chat_id} (${curr.name})`);
        }
        this.send_notification(users.join('\n'), chat_id, this);
    }

    async #admin_get_blocked(chat_id: string) {
        const current = await this.db.query(
            'SELECT chat_id, name FROM users WHERE blocked = TRUE ' +
            'AND pending = FALSE;'
        );
        if(current.length === 0) {
            this.send_notification(
                'There are no blocked users', chat_id, this
            );
            return;
        }
        const users = ["Blocked users:"];
        for(const curr of current) {
            users.push(`${curr.chat_id} (${curr.name})`);
        }
        this.send_notification(users.join('\n'), chat_id, this);
    }

    async #admin_get_admins(chat_id: string) {
        const current = await this.db.query(
            'SELECT chat_id, name FROM users WHERE admin = TRUE;'
        );
        if(current.length === 0) {
            this.send_notification(
                'There are no admins ???', chat_id, this
            );
            return;
        }
        const users = ["Admins:"];
        for(const curr of current) {
            users.push(`${curr.chat_id} (${curr.name})`);
        }
        this.send_notification(users.join('\n'), chat_id, this);
    }

    async #admin_get_active(chat_id: string) {
        const current = await this.db.query(
            'SELECT chat_id, name FROM users WHERE blocked = FALSE;'
        );
        if(current.length === 0) {
            this.send_notification(
                'There are no active users ???', chat_id, this
            );
            return;
        }
        const users = ["Active users:"];
        for(const curr of current) {
            users.push(`${curr.chat_id} (${curr.name})`);
        }
        this.send_notification(users.join('\n'), chat_id, this);
    }

    #request_help(chat_id: string) {
        this.send_notification(
            "These are the command options (parameters are marked with _$_ and are explained below):\n\n" +
            "*add* (add subscription for a specific route, day, notification style)\n\n" +
            "_message style_: add $routes [days=$days] [seats=$seats]\n\n" +
            "_message example_: add Destination1,Destination2- days=Monday,Thursday seats=true\n\n" +
            "*stop* (stop a subscription for a specific route or 'all')\n\n" +
            "_message style_: stop $routes|all\n" +
            "_message example_: stop all\n\n" +
            "*info* (see all you subscriptions and their configurations)\n\n" +
            "_message_: info\n\n" +
            "*status* (see all active subscriptions for all users)\n\n" +
            "_message_: status\n\n\n" +
            "Parameters:\n\n" +
            "*$routes*: Comma separated list of destinations or itineraries. To add only one direction, use dashes: " +
            " <_Dest_>*-* for the route *to* Work and *-*<_Dest_> for the route *from* Work.\n" +
            "e.g. _Destination1,Destination2,Destination3_ *or* _-Destination1,Destination2-_\n\n" +
            "*$days* _(optional)_: Comma separated list of weekdays, preceeded with 'days='\n" +
            "e.g. _days=Tuesday,Wednesday,Friday_\n\n" +
            "*$seats* _(optional)_: _seats=true_ or _seats=false_.\n" +
            "If _false_, only get notified if a day is added. If _true_, also get notified if new seats get free."
            , chat_id, this
        );
    }

    async #admin_request(chat_id: string, request_arr: string[]) {
        const admin_msg = (
            'Please enter\n_admin add <chat-id>_\nto add a user,\n' +
            '_admin admin <chat-id>_\nto make a user an admin, or\n' +
            '_admin block <chat-id>_\nto block a user.\n\n' +
            'Use\n_admin users_\nto check the user count,\n' +
            '_admin requests_\nto check pending requests,\n' +
            '_admin blocked_\nto check blocked users,\n' +
            '_admin admins_\nto check who is an admin, and\n' +
            '_admin active_\nto get a list of all unblocked users.'
        )
        const admin = await this.db.query(
            `SELECT chat_id FROM users WHERE chat_id = ${chat_id} ` +
            'AND admin = TRUE;'
        );
        if(admin.length === 0) return;
        
        if(request_arr.length ===  0) {
            this.send_notification(admin_msg, chat_id, this);
            return;
        }
        const command = request_arr.shift();
        if(command === 'users') {
            this.#admin_get_users(chat_id);
            return;
        }
        if(command === 'requests') {
            this.#admin_get_requests(chat_id);
            return;
        }
        if(command === 'blocked') {
            this.#admin_get_blocked(chat_id);
            return;
        }
        if(command === 'admins') {
            this.#admin_get_admins(chat_id);
            return;
        }
        if(command === 'active') {
            this.#admin_get_active(chat_id);
            return;
        }
        if(
            command !== 'add' && command !== 'admin' && command !== 'block'
        ) {
            this.send_notification(
                `Unknown admin command '${command}'.\n\n` + admin_msg,
                chat_id,
                this
            );
            return;
        }
        if(request_arr.length === 0) {
            this.send_notification(
                `Please specify a chat Id to use command ${command}`,
                chat_id,
                this
            );
            return;
        }
        const users = Shuttle.helper_split(request_arr.shift(), ',');
        switch(command) {
            case 'add':
                for(const user of users) {
                    this.#add_user(user, chat_id);
                }
                break;
            case 'admin':
                for(const user of users) {
                    this.#add_admin(user, chat_id);
                }
                break;
            case 'block':
                for(const user of users) {
                    this.#block_user(user, chat_id);
                }
        }
    }

    async #add_user(user: string, chat_id: string) {
        if(!/^\d+$/.test(user)) {
            this.send_notification(
                `Error: Chat Id '${user}' is not a number`, chat_id, this
            );
            return;
        }
        const current = await this.db.query(
            `SELECT blocked, pending FROM users WHERE chat_id = ${user};`
        );
        if(current.length === 0) {
            this.send_notification(
                `*Error:* There is no request from user '${user}'`,
                chat_id,
                this
            );
            return;
        }
        if(!current[0].blocked) {
            this.send_notification(
                `User '${user}' wasn't blocked`,
                chat_id,
                this
            );
            return;
        }
        let messages = [];
        if(!current[0].pending) {
            messages.push("User wasn't pending.");
        }
        try {
            await this.db.update(
                'users',
                'blocked = FALSE, pending = FALSE, request_sent = FALSE',
                `chat_id = ${user}`
            );
            this.send_notification("You have been added!", user, this);
            messages.push(`Added user ${user}.`);
            this.#notify_admins(`Added user ${user}.`, chat_id);
        }
        catch(e) {
            messages.push(`Error while updating user ${user}: ${e}.`);
        }
        if(messages.length > 0) {
            this.send_notification(messages.join('\n'), chat_id, this);
        }
    }

    async #add_admin(user: string, chat_id: string) {
        if(!/^\d+$/.test(user)) {
            this.send_notification(
                `Error: Chat Id '${user}' is not a number`, chat_id, this
            );
            return;
        }
        const current = await this.db.query(
            `SELECT blocked, pending, admin FROM users WHERE chat_id = ${user};`
        );
        if(current.length === 0) {
            this.send_notification(
                `*Error:* There is no user '${user}'`,
                chat_id,
                this
            );
            return;
        }
        if(!current[0].blocked && current[0].admin) {
            this.send_notification(
                `User '${user}' wasn't blocked and already is admin`,
                chat_id,
                this
            );
            return;
        }
        let messages = [];
        if(current[0].admin) {
            messages.push("User already was admin, but blocked.");
        }
        if(!current[0].pending) {
            messages.push("User wasn't pending.");
        }
        try {
            await this.db.update(
                'users',
                'blocked = FALSE, pending = FALSE, ' +
                'admin = TRUE, request_sent = FALSE',
                `chat_id = ${user}`
            );
            this.send_notification(
                "*You have been made admin!*\n\n" +
                'You can enter\n_admin add <chat-id>_\nto add a user,\n' +
                '_admin admin <chat-id>_\nto make a user an admin, or\n' +
                '_admin block <chat-id>_\nto block a user.\n\n' +
                'Use\n_admin users_\nto check the user count,\n' +
                '_admin requests_\nto check pending requests,\n' +
                '_admin blocked_\nto check blocked users,\n' +
                '_admin admins_\nto check who is an admin, and\n' +
                '_admin active_\nto get a list of all unblocked users.',
                user,
                this
            );
            messages.push(`Made user ${user} admin.`);
            this.#notify_admins(`Made user ${user} admin.`, chat_id);
        }
        catch(e) {
            messages.push(`Error while updating user ${user}: ${e}.`);
        }
        if(messages.length > 0) {
            this.send_notification(messages.join('\n'), chat_id, this);
        }
    }

    async #block_user(user: string, chat_id: string) {
        if(!/^\d+$/.test(user)) {
            this.send_notification(
                `Error: Chat Id '${user}' is not a number`, chat_id, this
            );
            return;
        }
        if(user === chat_id) {
            this.send_notification(
                `*Error:* You cannot block yourself`,
                chat_id,
                this
            );
            return;
        }
        const current = await this.db.query(
            `SELECT blocked, pending FROM users WHERE chat_id = ${user};`
        );
        if(current.length === 0) {
            this.send_notification(
                `*Error:* There is no request from user '${user}'`,
                chat_id,
                this
            );
            return;
        }
        if(!current[0].pending && current[0].blocked) {
            this.send_notification(
                `User '${user}' is already blocked`,
                chat_id,
                this
            );
            return;
        }
        let messages = [];
        if(!current[0].blocked) {
            messages.push("User was added before.");
        }
        if(!current[0].pending) {
            messages.push("User wasn't pending.");
        }
        try {
            await this.db.update(
                'users',
                'blocked = TRUE, pending = FALSE, ' +
                'admin = FALSE, request_sent = FALSE',
                `chat_id = ${user}`
            );
            if(current[0].pending) {
                this.send_notification(
                    "The join request was denied!", user, this
                );
            }
            else {
                this.send_notification("You have been blocked!", user, this);
            }
            this.#notify_admins(`Blocked user ${user}.`);
        }
        catch(e) {
            messages.push(`Error while updating user ${user}: ${e}.`);
        }
        if(messages.length > 0) {
            this.send_notification(messages.join('\n'), chat_id, this);
        }
    }

    #invalid_request(chat_id: string, cmd: string) {
        this.send_notification(
            `Unknown command '${cmd}', type _help_ to see the instructions`,
            chat_id,
            this
        );
    }

    async #initialize_route(
        route: string, chat_id: string = null
    ): Promise<boolean> {
        try {
            this.schedules[route] = await this.#get_updates(
                route, this, true
            );
            // {'Thursday 17.09.': 0, 'Friday 18.09.': 0}
        }
        catch(e) {
            if(chat_id) {
                this.send_notification(
                    `Error subscribing to route ${route}: ${e}`, chat_id, this
                );
            }
            else {
                this.error(`Error subscribing to route ${route}: ${e}`);
            }
            return false;
        }
        this.#timers[route] = setInterval(
            this.#get_updates, this.#refresh_rate * 60 * 1000, route, this
        );
        return true;
    }

    async subscribe_to_route(
        route: string,
        chat_id_raw: string | number,
        days: string[],
        seats: boolean = true
    ) {
        const chat_id = '' + chat_id_raw;
        if(!this.#timers[route]) {
            const res = await this.#initialize_route(route, chat_id);
            if(!res) return;
        }
        
        await this.db.deleteRows(
            'routes', `chat_id = ${chat_id} AND route = '${route}'`
        );
        const user_data: any[][] = [['chat_id', 'route', 'day', 'seats']];
        for(const day of days) {
            user_data.push([chat_id, `'${route}'`, `'${day}'`, seats]);
        }
        await this.db.insertData('routes', user_data);
    }

    async unsubscribe_from_route(route: string, chat_id: string | number) {
        const current = await this.db.query(
            'SELECT route FROM routes WHERE chat_id = ' +
            `${chat_id} AND route = '${route}';`
        );
        if(current.length > 0) {
            return [true, `Unsubscribed from route ${route}`];
        }
        else {
            return [false, `No subscription for route ${route}`];
        }
    }

    fetch_data(origin: string, destination: string) {
        return (
            '{"operationName":"HcvSchedules","variables":{"dropoff":{' +
            this.#destinations[destination] +
            '},"pickup":{' +
            this.#destinations[origin] +
            '},"time":{"arrivalSec":0,"pickupSec":0}},"query":"query HcvSchedules($pickup: InputCoordinate!, $dropoff: InputCoordinate!, $time: InputTime!) {\\n  hcvSchedules(pickup: $pickup, dropoff: $dropoff, time: $time) {\\n    ...ScheduleFragment\\n    __typename\\n  }\\n}\\n\\nfragment JourneyDetailFragment on RVWebCommonJourneyDetail {\\n  dropStopLocation {\\n    ...StopFragment\\n    __typename\\n  }\\n  pickupStopLocation {\\n    ...StopFragment\\n    __typename\\n  }\\n  toDropoffDescription\\n  toPickupStopDescription\\n  __typename\\n}\\n\\nfragment CoordinateFragment on RVWebCommonCoordinate {\\n  latitude\\n  longitude\\n  __typename\\n}\\n\\nfragment StopFragment on RVWebCommonStop {\\n  coordinate {\\n    ...CoordinateFragment\\n    __typename\\n  }\\n  description\\n  name\\n  neighborhood\\n  uuid\\n  __typename\\n}\\n\\nfragment RouteFragment on RVWebCommonRoute {\\n  name\\n  color\\n  description\\n  dropStopLocation {\\n    ...StopFragment\\n    __typename\\n  }\\n  pickupStopLocation {\\n    ...StopFragment\\n    __typename\\n  }\\n  uuid\\n  __typename\\n}\\n\\nfragment ScheduleFragment on RVWebCommonHCVScheduleResponse {\\n  filterDays\\n  schedules {\\n    day\\n    etaTimestampSec\\n    etdTimestampSec\\n    formattedETA\\n    formattedETD\\n    formattedFare\\n    journeyDetail {\\n      ...JourneyDetailFragment\\n      __typename\\n    }\\n    programUUID\\n    route {\\n      ...RouteFragment\\n      __typename\\n    }\\n    scheduleUUID\\n    seatsAvailable\\n    __typename\\n  }\\n  __typename\\n}\\n"}'
        );
    }

    fetch_updates(
        origin: string,
        destination: string,
        instance: Shuttle
    ): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const request = https.request(
                instance.fetch_options,
                (res: IncomingMessage) => {
                    let body = '';
                    const gunzip = zlib.createGunzip();
                    res.pipe(gunzip);
                    gunzip.on('error', (e) => {
                        reject(e);
                    });
                    gunzip.on('data', (chunk: any) => {
                        body+= chunk.toString();
                    });
                    gunzip.on('end', () => {
                        try {
                            resolve(body);
                        }
                        catch(e) {
                            reject(e);
                        }
                    });
                }
            );
            
            request.on('error', (e: Error) => {
                reject(e);
            });
        
            request.write(instance.fetch_data(origin, destination));
            request.end();
        });
    }

    async #get_updates(
        route: string,
        instance: Shuttle,
        initial: boolean = false
    ): Promise<any> {
        const og_dest = Shuttle.helper_split(route, '-');
        for(let i = 1; i <= 3; i++) {
            let response: any;
            try {
                const fetch = await instance.fetch_updates(
                    og_dest[0], og_dest[1], instance
                );
                response = JSON.parse(fetch);
            }
            catch(e) {
                instance.error(
                    `Fetching schedule for route ${route} ` +
                    `failed on try ${i} with ${e}`
                );
                continue
            }

            if(
                !response.data
                && response.errors
                && response.errors[0]
                && response.errors[0]['message'] === 'unauthorized'
            ) {
                throw Error(
                    'It seems like the session has expired, please ' +
                    'log in on https://m.uber.com/'
                );
            }

            try {
                const new_schedule = instance.parse_schedule(
                    response.data.hcvSchedules.schedules, instance
                );
                if(initial) {
                    return new_schedule;
                }
                await instance.check_new_days(new_schedule, route, instance);
                await instance.check_new_seats(new_schedule, route, instance);
                instance.update_schedule(new_schedule, route);
                return;
            }
            catch(e) {
                instance.error(
                    `Parsing schedule for route ${route} ` +
                    `failed on try ${i} with ${e}`
                );
            }
        }
        if(initial) {
            throw Error("Initial schedules couldn't be fetched");
        }
    }

    parse_schedule(schedule_arr: Schedule[], instance: Shuttle) {
        let schedule = {};
        const  today = new Date();
        let base_day = new Date();
        let last_day: string;
        for(const day of schedule_arr){
            if(last_day !== day.day) {
                if(day.day === "Tomorrow") {
                    base_day.setDate(base_day.getDate() + 1);
                }
                else if(day.day !== "Today") {
                    let diff = instance.weekdays_index[day.day] - base_day.getDay();
                    if(diff <= 0) {
                        diff += 7;
                    }
                    base_day.setDate(base_day.getDate() + diff);
                }
            }
            const date_str = (
                instance.index_weekdays[base_day.getDay()] +
                " " +
                base_day.getDate().toString().padStart(2, "0") +
                "." +
                (base_day.getMonth() + 1).toString().padStart(2, "0") +
                "."
            );
            if(schedule[date_str] !== undefined) {
                schedule[date_str]["seats"] += day.seatsAvailable;
            }
            else {
                schedule[date_str] = {
                    seats: day.seatsAvailable,
                    added: today
                };
            }
            last_day = day.day;
        }
        return schedule;
    }

    update_schedule(new_schedule: any, route: string) {
        if(!this.schedules[route]) {
            this.schedules[route] = {};
        }
        for(const date in new_schedule) {
            this.schedules[route][date] = new_schedule[date];
        }
    }

    async check_new_days(new_schedule: any, route: string, instance: Shuttle) {
        let recipients = {};
        let routes = {};
        let current = await instance.db.query(
            `SELECT DISTINCT chat_id, day FROM routes WHERE route = '${route}'`
        );
        for(const curr of current) {
            if(!routes[curr.chat_id]) {
                routes[curr.chat_id] = {};
                routes[curr.chat_id][curr.day] = true
            }
            else {
                routes[curr.chat_id][curr.day] = true;
            }
        }
        for(const day in new_schedule) {
            if(!Object.keys(instance.schedules[route]).includes(day)) {
                const weekday = Shuttle.helper_split(day, ' ')[0];
                for(const rec in routes) {
                    if(routes[rec][weekday]) {
                        if(recipients[rec]) {
                            recipients[rec].push(
                                `*${route}*\nSeats are now available for ${day}`
                            );
                        }
                        else {
                            recipients[rec] = [
                                `*${route}*\nSeats are now available for ${day}`
                            ];
                        }
                    }
                }
            }
        }
        instance.notify(recipients, instance);
    }

    async check_new_seats(
        new_schedule: any,
        route: string,
        instance: Shuttle,
        initial: boolean = false
    ) {
        let recipients = {};
        let routes = {};
        let current = await instance.db.query(
            'SELECT DISTINCT chat_id, day FROM routes WHERE ' +
            `route = '${route}' AND seats = TRUE`
        );
        for(const curr of current) {
            if(!routes[curr.chat_id]) {
                routes[curr.chat_id] = {};
                routes[curr.chat_id][curr.day] = true
            }
            else {
                routes[curr.chat_id][curr.day] = true;
            }
        }
        for(const day in instance.schedules[route]) {
            if(
                (instance.schedules[route][day]["seats"] === 0 || initial)
                && new_schedule[day]
                && new_schedule[day]["seats"] != 0
            ) {
                const weekday = Shuttle.helper_split(day, ' ')[0];
                for(const rec in routes) {
                    if(routes[rec][weekday]) {
                        if(recipients[rec]) {
                            recipients[rec].push(
                                `*${route}*\n*${new_schedule[day]["seats"]}* ` +
                                `free seats on ${day}`
                            );
                        }
                        else {
                            recipients[rec] = [
                                `*${route}*\n*${new_schedule[day]["seats"]}* ` +
                                `free seats on ${day}`
                            ];
                        }
                    }
                }
            }
        }
        instance.notify(recipients, instance);
    }

    notify(recipients: any, instance: Shuttle) {
        for(const chat_id in recipients) {
            instance.send_notification(
                recipients[chat_id].join('\n'), chat_id, instance
            );
        }
    }

    send_notification(
        msg: string,
        chat_id_raw: string | number,
        instance: Shuttle
    ): Promise<string> {
        const chat_id = '' + chat_id_raw;
        msg = msg.replaceAll(/([.\-<>()[\]!|=])/g, '\\$1');

        const data = JSON.stringify({
            chat_id: chat_id,
            text: msg,
            parse_mode: 'MarkdownV2',
            // disable_notification: 'True',
        });
        const options = instance.message_options;
        options.headers['Content-Length'] = data.length;
        return new Promise((resolve, reject) => {
            const request = https.request(options, (res: IncomingMessage) => {
                let body = '';
                res.on('error', (e: Error) => {
                    instance.error(
                        `Sending notification '${msg}' failed with ${e}`
                    );
                    resolve(
                        `Sending notification '${msg}' failed with ${e}`
                    );
                });

                res.on('data', (chunk: any) => {
                    body += chunk.toString();
                });
                
                res.on('end', () => {
                    resolve(body);
                });
            });
            
            request.on('error', (e: Error) => {
                instance.error(
                    `Sending notification '${msg}' failed with ${e}`
                );
            });
            request.write(data);
            request.end();
        });
    }

    async notify_all(msg: string, instance: Shuttle) {
        const users = await instance.db.query(
            `SELECT DISTINCT chat_id FROM users WHERE blocked = FALSE;`
        );
        for(const user of users) {
            await this.send_notification(msg, user.chat_id, this);
        }
    }

}

export default Shuttle;
