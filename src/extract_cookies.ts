import DatabaseHandler from './database_handler.js';
import { globSync } from 'glob';

async function get_cookies(paths: string[]) {
    const host_names = ["'.uber.com'", "'.m.uber.com'", "'m.uber.com'"];
    let errors: string[] = [];
    for(const path of paths) {
        try {
            const db = new DatabaseHandler(path);
            await db.open();
            const rows: any[] = await db.query(
                'SELECT name, value, host FROM moz_cookies WHERE host ' +
                `IN (${host_names.join(', ')});`
            );
            await db.close();
            
            const new_db = new DatabaseHandler("new_cookies.sqlite", true);
            await new_db.createDatabase();
            await new_db.createTable(
                "moz_cookies",
                'name TEXT, value TEXT, host TEXT'
            );
            let data: any[][] = [['name', 'value', 'host']];
            for(const row of rows) {
                data.push([`'${row.name}'`, `'${row.value}'`, `'${row.host}'`]);
            }
            await new_db.insertData('moz_cookies', data);
            await new_db.close();
            return;
        }
        catch(e) {
            errors.push(e);
        }
    }
    throw Error(
        "Couldn't find the uber cookies in paths " +
        `'${paths.join("', '")}': '${errors.join("', '")}'`
    );
}

let paths: string[];

if(process.env.APPDATA) {
    paths = globSync(`${process.env.APPDATA}/Mozilla/Firefox/Profiles/*default*/cookies.sqlite`);
}
else if(process.env.HOME){
    paths = globSync(`${process.env.HOME}/snap/firefox/common/.mozilla/firefox/*default*/cookies.sqlite`);
}

paths.unshift(process.argv.pop());

await get_cookies(paths);
