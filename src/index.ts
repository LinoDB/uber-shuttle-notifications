import * as https from 'https';
import type { IncomingMessage, ServerResponse } from 'http';
import * as fs from 'fs';
import Shuttle from './shuttle.js';

interface NodeError {
  name: any,
  message: any,
  cause: any,
  code: any,
}

let has_crashed: boolean = false;

function set_string_arg(name: string) {
  return (
    process.env[name] && process.env[name] !== '' ? process.env[name] : null
  );
}

function set_bool_arg(name: string) {
  return (
    typeof process.env[name] === 'string' &&
    process.env[name].toLowerCase() === 'true'
    ? true
    : false
  );
}

function parse_string_arg(
  flag: string,
  name: string,
  optional_params: string[],
  arg: number
): [string, number] {
  if(
    arg + 1 < optional_params.length
    && !optional_params[arg + 1].startsWith('-')
  ) {
    arg++;
    return [optional_params[arg], arg];
  }
  else {
    throw Error(`Missing input argument for ${name} '${flag}'`);
  }
}

function parse_arguments() {
  let unknown_params: string[] = [];
  let verbose = set_bool_arg('SHUTTLE_VERBOSE');
  let delete_webhook = set_bool_arg('SHUTTLE_DELETE_WEBHOOK');
  let fetch_updates = set_bool_arg('SHUTTLE_FETCH');
  let cookies_path: string = set_string_arg('SHUTTLE_COOKIES_PATH');
  let private_key: string = set_string_arg('SHUTTLE_PRIVATE_KEY');
  let certificate: string = set_string_arg('SHUTTLE_CERTIFICATE');
  let secret: string = set_string_arg('SHUTTLE_SECRET');
  let set_webhook: string = set_string_arg('SHUTTLE_SET_WEBHOOK');
  let refresh_rate = (
    process.env.SHUTTLE_REFRESH_RATE && process.env.SHUTTLE_REFRESH_RATE !== ''
    ? parseFloat(process.env.SHUTTLE_REFRESH_RATE)
    : 5
  );
  if(isNaN(refresh_rate)) {
    throw Error(
      'Invalid argument for environment SHUTTLE_REFRESH_RATE ' +
      `'${process.env.SHUTTLE_REFRESH_RATE}': Must be a number`
    );
  }
  let telegram_bot = process.env.TELEGRAM_BOT_TOKEN;
  process.argv.shift();
  while(!fs.lstatSync(process.argv.shift()).isFile()) {}

  if(process.argv.length === 0 || process.argv[0].startsWith('-')) {
    if(!telegram_bot || telegram_bot === '') {
      throw Error("Missing input for telegram bot");
    }
  }
  else {
    telegram_bot = process.argv.shift();
  }

  let optional_params: string[] = [];
  for(const arg of process.argv) {
    if(arg.startsWith('-')) {
      for(const char of arg.slice(1)) {
        optional_params.push('-' + char);
      }
    }
    else {
      optional_params.push(arg);
    }
  }

  for(let arg: number = 0; arg < optional_params.length; arg++) {
    if(optional_params[arg] === '-v') {
      verbose = true;
    }
    else if(optional_params[arg] === '-f') {
      fetch_updates = true;
    }
    else if(optional_params[arg] === '-w') {
      [set_webhook, arg] = parse_string_arg(
        '-w', 'webhook url', optional_params, arg
      );
    }
    else if(optional_params[arg] === '-s') {
      [secret, arg] = parse_string_arg(
        '-s', 'secret', optional_params, arg
      );
    }
    else if(optional_params[arg] === '-d') {
      delete_webhook = true;
    }
    else if(optional_params[arg] === '-c') {
      [cookies_path, arg] = parse_string_arg(
        '-c', 'cookie path', optional_params, arg
      );
    }
    else if(optional_params[arg] === '-p') {
      [private_key, arg] = parse_string_arg(
        '-p', 'private key', optional_params, arg
      );
    }
    else if(optional_params[arg] === '-t') {
      [certificate, arg] = parse_string_arg(
        '-t', 'certificate', optional_params, arg
      );
    }
    else if(optional_params[arg] === '-r') {
      if(
        arg + 1 < optional_params.length
        && !optional_params[arg + 1].startsWith('-')
      ) {
        refresh_rate = parseFloat(optional_params[++arg]);
        if(isNaN(refresh_rate)) {
          throw Error(
            'Invalid argument for refresh rate (-r) ' +
            `'${optional_params[arg]}': Must be a number`
          );
        }
      }
      else {
        throw Error("Missing input argument for refresh rate '-r'");
      }
    }
    else {
      unknown_params.push(optional_params[arg]);
    }
  }
  if(unknown_params.length > 0) {
    console.warn(
      `Received unknown parameters: '${unknown_params.join("', '")}'`
    );
  }
  if(fetch_updates) {
    set_webhook = null;
  }
  else {
    if(!(private_key && certificate)) {
      throw Error(
        "Missing input parameters private key (-p) and/or certificate (-t). " +
        "Please specify or use fetch mode (-f).");
    }
  }
  return {
    cookies_path: cookies_path,
    telegram_bot: telegram_bot,
    verbose: verbose,
    fetch_updates: fetch_updates,
    set_webhook: set_webhook,
    delete_webhook: delete_webhook && !fetch_updates,
    refresh_rate: refresh_rate,
    secret: secret,
    private_key: private_key,
    certificate: certificate,
  }
}

function parse_header(headers: string[], key: string): string {
  for(let h in headers) {
    if(headers[h] === key) {
      return headers[parseInt(h) + 1];
    }
  }
  return null;
}

function start_server(
  shuttle: Shuttle,
  private_key: string,
  certificate: string,
  webhook: string = null
) {
  const server = https.createServer({
      key: fs.readFileSync(private_key),
      cert: fs.readFileSync(certificate),
  }, (req: IncomingMessage, res: ServerResponse) => {
    if(req.method !== 'POST') {
      shuttle.error(`Wrong request method: ${req.method}`);
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/plain');
      res.end('400 - Bad Request');
      return;
    }
    const secret = parse_header(
      req.rawHeaders, "X-Telegram-Bot-Api-Secret-Token"
    );
    if(!shuttle.test_secret(secret)) {
      shuttle.error('Wrong telegram secret in request');
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/plain');
      res.end('400 - Bad Request');
      return;
    }
    let body = ''
    req.on('data', (chunk: any) => {
      body += chunk.toString();
    });
  
    req.on('end', () => {
      let update: any;
      try {
        update = JSON.parse(body);
      }
      catch(e) {
        shuttle.error(
          `An error occurred while reading the request body: ${e}!`
        );
        res.statusCode = 400;
        res.setHeader('Content-Type', 'text/plain');
        res.end('400 - Bad Request');
        return;
      }
      if(
        !update.message
        || !update.message.chat
        || !update.message.chat.id
        || !update.message.text
      ) {
        shuttle.error('Wrong request data structure');
        res.statusCode = 400;
        res.setHeader('Content-Type', 'text/plain');
        res.end('400 - Bad Request');
      }
      else {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain');
        res.end('OK!\n');
        shuttle.process_request(
          update.message.chat.id,
          update.message.text,
          update.message.chat.first_name
        );
      }
    });
  });
  server.listen(443);
  server.on('listening', () => {
    if(webhook) {
      console.log(`Server started on ${webhook}`);
    }
    else {
      console.log('Server started');
    }
  });
}

async function setup(params: any): Promise<Shuttle> {
  const shuttle = new Shuttle(
    params.telegram_bot,
    params.cookies_path,
    params.refresh_rate,
    params.verbose,
    params.set_webhook,
    params.delete_webhook,
    params.secret
  );
  
  process.on('SIGINT', async () => {
    console.warn("Terminating process...");
    await shuttle.shutdown(0);
    process.exit(0);
  });

  process.on('uncaughtException', async (e: NodeError) => {
    if(e.code == 'Z_DATA_ERROR') {
      console.error(`Handled uncaught exception ${e}`);
    }
    else {
      setTimeout(() => {process.exit(1);}, 5000);
      if(!has_crashed) {
        has_crashed = true;
        console.error(`Server stopped with uncaught exception: ${e}`);
        if(
          e.message
          && e.message.startsWith("It seems like the session has expired")
        ) {
          await shuttle.notify_all(
            "Lost authorization for the uber session", shuttle
          );
          await shuttle.shutdown(0);
        }
        else {
          await shuttle.shutdown(1);
        }
        process.exit(1);
      }
    }
  });

  process.on('unhandledRejection', async (reason: Error, promise: any) => {
    setTimeout(() => {process.exit(1);}, 5000);
    if(!has_crashed) {
      has_crashed = true;
      console.error(
        `Server stopped with unhandled rejection of '${promise}' for reason: ` +
        reason
      );
      if(
        reason.message
        && reason.message.startsWith("It seems like the session has expired")
      ) {
        await shuttle.notify_all(
          "Lost authorization for the uber session", shuttle
        );
        await shuttle.shutdown(0);
      }
      else {
        await shuttle.shutdown(1);
      }
      process.exit(1);
    }
  });

  await shuttle.initialize();

  return shuttle;
}

const params = parse_arguments();
const shuttle = await setup(params);
if(params.fetch_updates) {
  shuttle.fetch_loop();
}
else {
  start_server(
    shuttle, params.private_key, params.certificate, params.set_webhook
  );
}
