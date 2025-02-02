# Uber shuttle notifications via Telegram

This is a project to receive notifications for corporate uber shuttle services via Telegram. The schedule data is fetched from the uber website using user session cookies. This allows the service to check if new days were added to the schedule or if seats were freed up recently. Notifications are then send to the user via Telegram, being an alternative to manually refreshing the schedule data on the uber app or website.

Telegram is used for the update notifications because of its free to use API.


## Interactions with uber

The service accesses the cookie database from Firefox to authenticate as the uber user when sending graphql requests to the uber website. The (refresh) rate of these requests can be defined by the user. Only routes that users are currently _subscribed_ to get fetched. The cookies can also be isolated into a [separate database](#isolate-cookies-from-the-firefox-database).


## Interactions with Telegram

This service uses a Telegram bot to exchange messages with the users. There are two possible models that can be used: Fetching the Telegram message updates constantly (which some popular Telegram bot APIs seem to do as well), or setting up a server and a webhook. Fetching the data is the fastest to set up and seems to work well. To set up a server, only the server certificates and url are needed to receive Telegram updates to.


# Getting started

## Set up user data

### Uber

Log in on https://m.uber.com/ using the Firefox browser. This app will use the session cookies from this website to make the schedule update request.

### Telegram

Create a Telegram bot using [@BotFather](https://t.me/botfather) (see details on https://core.telegram.org/bots/tutorial). The bot token will be needed to use the bot for communication. The Telegram API reference can be found on https://core.telegram.org/bots/api.


## Clone the repo

```bash
git clone https://github.com/LinoDB/uber-shuttle-notifications.git
cd uber-shuttle-notifications
```


## Install dependencies

```bash
npm install
```


## Build the project

```bash
npm run build
```


## Create a user database

Telegram bots are public by default. When using this app, users have to be added to a user database manually to ensure privacy. The owner of the app and group admins have access to the public Telegram account name and the Telegram Id of all users. To start out, add an admin to the user database. The Telegram Id of a user can be found by sending a message to the Telegram bot and opening _<span>https</span>://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates_ in a browser. Here appear all messages that reached the bot and weren't yet processed. The user Id can be found under `result[0].message.from.id`.

Other users can be later added to the user group through messages sent to the bot via Telegram by an admin.

Use the VSCode launch configuration `create_database build & run` or run

```bash
node built/create_database.js <TELEGRAM_USER_ID> <NAME> true
```

where
- TELEGRAM_USER_ID: User Id obtained from the bot updates
- NAME: User name (this doesn't need to be the actual Telegram user name)
- `true` indicating the user is an admin

This creates a _data.sqlite_ database for saving user and subscription information.


## Define the destinations

To finalize the setup, the destinations of the shuttle service have to be added. One destination per route is enough. This can be done by adding a _destination.json_ file to the root folder of the project, which defines the coordinates for "Work" and at least one other destination. Use the file _destinations.template.json_ and rename it to _destinations.json_ afterwards for this purpose. Each destination has a name (key) and a string (value) that contains the latitude and longitude for that location (see the "Example"). The coordinates just have to be close to where the shuttle actually stops.


## Run the service

Use the VSCode launch configuration `shuttle-notifications build & run` or run

```bash
node --env-file=.env built/index.js
```

You can use the a _.env_ file to define inputs as environment variables (use _.env.template_ and rename it to _.env_) or use command line arguments instead. When both are given, CL parameters will have priority. These are the parameters that can be used:

| Environment variable | CL parameter | Function |
| --- | --- | --- |
| TELEGRAM_BOT_TOKEN |  | [Mandatory] CL parameter at first position. |
| SHUTTLE_VERBOSE | -v | [Optional] Flag parameter indicating increased verbosity. |
| SHUTTLE_REFRESH_RATE | -r \<refresh rate\> | [Optional] Rational number defining the resfresh rate for fetching uber updates in minutes. Default is 5.0. |
| SHUTTLE_COOKIES_PATH | -c \<cookie database path\> | [Optional] Path to the Firefox cookie database. Searches for the database at the default locations on Windows or Linux when not specified. |
| SHUTTLE_FETCH | -f | Flag parameter. Use this to fetch updates constantly instead of setting up a server and a webhook. |
| SHUTTLE_PRIVATE_KEY | -p \<private key path\> | Defines the path to the private key when using a server and a webhook. This parameter is mandatory when **-f** is not set. |
| SHUTTLE_CERTIFICATE | -t \<certificate path\> | Defines the path to the certificate when using a server and a webhook. This parameter is mandatory when **-f** is not set. |
| SHUTTLE_SET_WEBHOOK | -w \<webhook url\> | Define a webhook url for Telegram to send updates to. This will be ignored when **-f** is set. |
| SHUTTLE_DELETE_WEBHOOK | -d | Delete the webhook after shutting down the service. The webhook will automatically be deleted before starting the service when **-f** is set. |
| SHUTTLE_SECRET | -s <secret> | Define a secret that is checked when Telegram updates are received via a webhook. This secret is also used when setting up a webhook using **-w**. |

The environment variables from  _.env_ that needn't be used can just be omitted. For flag parameters, set the respective environment variable to **true** or **false**/_nothing_. Use the TZ environment variable to set the right timezone, if necessary.

Using CL parameters, an MWE with a refresh rate of 30s would look like this:

```bash
node built/index.js <TELEGRAM_BOT_TOKEN> -f -r .5
```

## Subscibe to a route

Send a message to the bot like **add routename** to start receiving notifications or **stop all** to stop receiving notifications. Send **help** for a user guide. For admins, sending **admin** prints a user guide for admins as well.

## Add other users

Other Telegram users can send the message **join** to the bot to request being added to the user group. An admin has to add them manually. Users can also be blocked.


# Other functions

## Isolate cookies from the Firefox database

To create a cookie database that only contains the necessary uber cookies extracted from the Firefox cookie database, run

```bash
node built/extract_cookies.js

# or defining a path to the database location
node built/extract_cookies.js /path/to/cookies.sqlite
```

Use this database by setting the environment variable SHUTTLE_COOKIES_PATH or using the CL parameter `-c new_cookies.sqlite`.
