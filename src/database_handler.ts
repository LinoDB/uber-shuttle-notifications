import _sqlite3 from 'sqlite3';
const sqlite3 = _sqlite3.verbose();

interface Query {
    name: string;
    value: string;
}

class DatabaseHandler {
    #db_id: string;
    #new_db: boolean;
    #db: typeof sqlite3.Database;

    constructor(db_id: string, new_db: boolean = false) {
        this.#db_id = db_id;
        this.#new_db = new_db;
    }

    async open() {
        if(this.#new_db) {
            throw Error(
                `This is a handler for a new database '${this.#db_id}' - ` +
                "use the 'createDatabase' method instead!"
            );
        }
        this.#db = await this.initialize_open();
    }

    initialize_open(): Promise<typeof sqlite3.Database> {
        return new Promise((resolve, reject) => {
            const db = new sqlite3.Database(
                this.#db_id, sqlite3.OPEN_READWRITE, async (err: any) => {
                    if (err) {
                        reject(err);
                    }
                    else {
                        resolve(db);
                    }
                }
            );
        });
    }

    async createDatabase() {
        if(!this.#new_db) {
            throw Error(
                `This is a handler for existing database '${this.#db_id}' - ` +
                "use the 'open' method instead!"
            );
        }
        this.#db = await this.initialize_createDatabase();
    }

    initialize_createDatabase() {
        return new Promise((resolve, reject) => {
            const db = new sqlite3.Database(
                this.#db_id,
                sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
                async (err: any) => {
                    if(err) {
                        reject(err);
                    }
                    else {
                        resolve(db);
                    }
                }
            );
        });
    }
    
    createTable(table_name: string, cols: string) {
        return new Promise((resolve, reject) => {
           this.#db.exec(
                `CREATE TABLE ${table_name} (${cols});`, (err: any) => {
                if(err) {
                    reject(err);
                }
                else {
                    resolve(true);
                }
            });
        });
    }

    query(query: string) {
        return new Promise<Query[]>((resolve, reject) => {
            this.#db.all(query, (err: any, rows: Query[]) => {
                if(err) {
                    reject(err);
                }
                else {
                    resolve(rows);
                }
            });
        });
    }
    
    insertData(table_name: string, data: any[][]) {
        return new Promise((resolve, reject) => {
            const cols = data.shift().join(', ')
            let values_arr = []
            while(data.length > 0) {
                values_arr.push(data.shift().join(', '))
            }
            const values = values_arr.join('), (')
            this.#db.exec(
                `INSERT INTO ${table_name} (${cols}) ` +
                `VALUES (${values});`, (err: any) => {
                if(err) {
                    reject(err);
                }
                else {
                    resolve(true);
                }
            });
        });
    }

    update(table_name: string, values: string, conditions: string) {
        return new Promise((resolve, reject) => {
            this.#db.exec(
                `UPDATE ${table_name} SET ` +
                values +
                ` WHERE ${conditions};`,
                (err: any) => {
                    if(err) {
                        reject(err);
                    }
                    else {
                        resolve(true);
                    }
                }
            );
        });
    }

    deleteRows(table_name: string, conditions: string) {
        return new Promise((resolve, reject) => {
            this.#db.exec(
                `DELETE FROM ${table_name} ` +
                `WHERE ${conditions};`, (err: any) => {
                if(err) {
                    reject(err);
                }
                else {
                    resolve(true);
                }
            });
        });
    }

    close() {
        return new Promise((resolve, reject) => {
            this.#db.close((err: any) => {
                if (err) {
                    reject(err);
                }
                resolve(true);
            });
        });
    }
}

export default DatabaseHandler;
