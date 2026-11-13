"use strict";

const execSync = require('child_process').execSync;
const spawnSync = require('child_process').spawnSync;
const puppeteer = require("puppeteer");
const term = require("terminal-kit").terminal;
const fs = require("fs");
const path = require("path");
const yargs = require("yargs");
const request = require('request');
const notifier = require('node-notifier');
var xml2js = require('xml2js');
var URL = require('url').URL; // for node.js version <= 8

const argv = yargs.options({
    v: { alias: 'videoUrls', type: 'array', demandOption: false },
    f: { alias: 'videoUrlsFile', type: 'string', demandOption: false, describe: 'Path to txt file containing the URLs (one URL for each line)' },
    u: { alias: 'SPIDusername', type: 'string', demandOption: false },
    e: { alias: 'polimiEmail', type: 'string', demandOption: false },
    p: { alias: 'SPIDpassword', type: 'string', demandOption: false },
    o: { alias: 'outputDirectory', type: 'string', default: 'videos' },
    k: { alias: 'noKeyring', type: 'boolean', default: false, demandOption: false, describe: 'Do not use system keyring' },
    t: { alias: 'noToastNotification', type: 'boolean', default: false, demandOption: false, describe: 'Disable toast notification' },
    i: { alias: 'timeout', type: 'number', demandOption: false, describe: 'Scale timeout by a factor X' },
    w: { alias: 'videoPwd', type: 'string', default: '', demandOption: false, describe: 'Default video password to use (you will be prompted to input the correct one if it\'s wrong or absent)' },
    a: { alias: 'archive', type: 'string', demandOption: false, describe: 'Specific archive number(s) to download (e.g. "1 2", "2", or "0" for all)' },
    x: { alias: 'extract', type: 'boolean', default: false, demandOption: false, describe: 'Just extract the links' }
})
    .help('h')
    .alias('h', 'help')
    .example('node $0 -v "https://politecnicomilano.webex.com/recordingservice/sites/politecnicomilano/recording/playback/8de59dbf0a0345c6b525ed45a2c50607"\n', "Standard usage")
    .example('node $0 -f URLsList.txt\n', "Standard usage")
    .example('node $0 -v "https://politecnicomilano.webex.com/recordingservice/sites/politecnicomilano/recording/playback/8de59dbf0a0345c6b525ed45a2c50607" "https://politecnicomilano.webex.com/recordingservice/sites/politecnicomilano/recording/playback/9ce59ddr5a0345c6b525ed45a2c50607"\n', "Multiple videos download")
    .example('node $0 -v "https://politecnicomilano.webex.com/recordingservice/sites/politecnicomilano/recording/playback/8de59dbf0a0345c6b525ed45a2c50607" -o "C:\\Lessons\\Videos"\n', "Define output directory (absoulte o relative path)")
    .example('node $0 -v "https://politecnicomilano.webex.com/recordingservice/sites/politecnicomilano/recording/playback/8de59dbf0a0345c6b525ed45a2c50607" -w PASSWORD\n', "Download password-protected video without needing to input the password manually")
    .example('node $0 -v "https://politecnicomilano.webex.com/recordingservice/sites/politecnicomilano/recording/playback/8de59dbf0a0345c6b525ed45a2c50607" -i 2\n', "Double timeout value")
    .example('node $0 -v "https://politecnicomilano.webex.com/recordingservice/sites/politecnicomilano/recording/playback/8de59dbf0a0345c6b525ed45a2c50607" -k\n', "Do not save the password into system keyring")
    .example('node $0 -v "https://politecnicomilano.webex.com/recordingservice/sites/politecnicomilano/recording/playback/8de59dbf0a0345c6b525ed45a2c50607" -t\n', "Disable system toast notification about finished download process")
    .argv;

function sanityChecks() {
    try {
        const aria2Ver = execSync('aria2c --version').toString().split('\n')[0];
        term.green(`Using ${aria2Ver}\n`);
    } catch (e) {
        term.red('You need aria2c in $PATH for this to work. Make sure it is a relatively recent one.');
        process.exit(22);
    }
    try {
        const ffmpegVer = execSync('ffmpeg -version').toString().split('\n')[0];
        term.green(`Using ${ffmpegVer}\n\n`);
    } catch (e) {
        term.red('FFmpeg is missing. You need a fairly recent release of FFmpeg in $PATH.');
        process.exit(23);
    }
    if (argv.videoUrls === undefined && argv.videoUrlsFile === undefined) {
        term.red("Missing URLs arguments.\n");
        process.exit();
    }
    if (argv.videoUrls !== undefined && argv.videoUrlsFile !== undefined) {
        term.red("Can't get URLs from both argument.\n");
        process.exit();
    }
    if (argv.videoUrlsFile !== undefined)
        argv.videoUrls = argv.videoUrlsFile; // merge argument

    if (argv.timeout !== undefined) {
        if (isNaN(argv.timeout) || argv.timeout < 0) {
            term.red("Incorrect timeout value. Insert a positive integer or float.\n");
            process.exit();
        } else {
            if (argv.timeout > 10) {
                term.red("This is a really big scale factor for the timeout value...\n");
                process.exit();
            } else {
                timeout = argv.timeout;
            }
        }
    }


    argv.outputDirectory = path.resolve(argv.outputDirectory);
    if (!fs.existsSync(argv.outputDirectory)) {
        console.log('Creating output directory: ' + argv.outputDirectory);
        try {
            fs.mkdirSync(argv.outputDirectory, {
                recursive: true
            }); // use native API for nested directory. No recursive function needed, but compatible only with node v10 or later
        } catch (e) {
            term.red("Can not create nested directories. Node v10 or later is required\n");
            process.exit();
        }
    }

}

function readFileToArray(path) {
    path = path.replace(/^["'\[]+|["'\]]+$/g, '');
    return fs.readFileSync(path, 'utf-8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

function parseVideoUrls(videoUrls) {
    let stringVideoUrls = JSON.stringify(videoUrls);
    if (stringVideoUrls.substr(stringVideoUrls.length - 5) == ".txt\"") // is path?
        return readFileToArray(stringVideoUrls);
    return videoUrls;
}

const notDownloaded = []; // take trace of not downloaded videos
var timeout = 1;
var browser = null;

async function downloadVideo(videoUrls, password, outputDirectory, videoPwd) {


    const recmanUrls = await extractRecmanUrls(videoUrls)
    if (recmanUrls.length > 0) {
        term.yellow('RecMan links have been found. Sadly, we need to login even if cookies are already saved...\n\n');

        for (let recmanUrl of recmanUrls) {
            let webex_urls = await extractRecordingsUrl(recmanUrl)
            videoUrls = videoUrls.concat(webex_urls)
        }

        console.log("\nExtraction complete! At this point Chrome's job is done, shutting it down...\n");
        if (browser != null) { await browser.close(); } // browser is no more required. Free up RAM!

        videoUrls = videoUrls.filter(url => !recmanUrls.includes(url)) // remove recman links not that we extracted the WebEx urls
        if (argv.extract === true) {
            console.log(`Extracted links (${videoUrls.length} total):`);
            console.log(videoUrls);
            term.green(`\nTotal recordings to download: ${videoUrls.length}\n`);
            return;
        }
        console.info(`\nVideo URLs after extraction (${videoUrls.length} total):\n`, videoUrls);
        term.green(`Total recordings to download: ${videoUrls.length}\n\n`);
    }

    const cookie = await getCookies(password)


    var headers = {
        'User-Agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.66 Safari/537.36",
        'Cookie': cookie,
        'accessPwd': videoPwd
    };

    var headers_json = { // copy headers and add 'Accept'
        ...headers,
        'Accept': "application/json, text/plain, */*"
    };


    for (let videoUrl of videoUrls) {
        if (videoUrl == "") continue; // jump empty url
        term.green(`\nStart downloading video: ${videoUrl}\n`);
        if (!('accessPwd' in headers_json))
            headers_json['accessPwd'] = '';


        if (extractRCID(videoUrl) != null) { // check if the videoUrl is in the new format https://politecnicomilano.webex.com/politecnicomilano/ldr.php?RCID=15abe8b5bcf02a50a20b056cc2263211
            var options = {
                url: videoUrl,
                headers: headers
            };
            var redirectUrl = await getRedirectUrl(options) // get videoUrl in the usual format. Needed to obtain the correct videoID , in order to use in the API
            if (redirectUrl !== null) {
                videoUrl = redirectUrl;
            }
        }

        var videoID = extractVideoID(videoUrl);
        if (videoID === null) {
            term.red('\nCan\'t find video ID. Going to the next one.\n');
            notDownloaded.push(videoUrl);
            continue;
        }



        var options = {
            url: 'https://politecnicomilano.webex.com/webappng/api/v1/recordings/' + videoID + '/stream?siteurl=politecnicomilano',
            headers: headers_json
        };

        try {
            var obj = JSON.parse(await doRequestAccept404(options));
        } catch (e) {
            term.red('\nError downloading this video. Going to the next one.\n');
            notDownloaded.push(videoUrl);
            continue;
        }

        if (obj.code == 54001) {
            term.yellow('\nThis video does not exist. Going to the next one...\n');
            notDownloaded.push(videoUrl);
            continue;
        }

        while (obj.code == 53005) {
            if (options.headers['accessPwd'] === '') {
                term.yellow('\nThis video is password protected:/' + (obj.recordName).trim() + '\n');
            }
            else {
                term.yellow('\nWrong password!/' + (obj.recordName).trim() + '\n');
            }

            var pwd = await promptPassword("Please insert the password (or 0 to skip this video): ");
            options.headers['accessPwd'] = pwd;

            if (pwd == 0) {
                term.red('\nSkipped. Going to the next one.\n');
                notDownloaded.push(videoUrl);
                break;
            }

            try {
                obj = JSON.parse(await doRequestAccept404(options));
            } catch (e) {
                if (e.statusCode = 429)
                    term.red('\nToo many incorrect password attempts, please wait some time before trying again. Going to the next one.\n');
                else
                    term.red('\nError downloading this video. Going to the next one.\n');
                notDownloaded.push(videoUrl);
                break;
            }
        }

        //We gave up on the video due to the password.
        if (notDownloaded.includes(videoUrl)) {
            continue;
        }


        var title = (obj.recordName).trim();
        console.log(`\nVideo title is: ${title}`);
        title = title.replace(/[/\\?%*:;|"<>]/g, '-'); // remove illegal characters
        var isoDate = obj.createTime;
        if (isoDate !== null && isoDate !== '') {
            let date = new Date(isoDate);
            let year = date.getFullYear();
            let month = date.getMonth() + 1;
            let dt = date.getDate();

            if (dt < 10) {
                dt = '0' + dt;
            }
            if (month < 10) {
                month = '0' + month;
            }
            let uploadDate = year + '_' + month + '_' + dt;
            title = 'Lesson ' + uploadDate + ' - ' + title;
        } else {
            // console.log("no upload date found");
        }

        var newAPI = false;
        var recordingDir, timestamp, token, filename = "";

        if (obj.mp4StreamOption) {
            recordingDir = obj.mp4StreamOption.recordingDir;
            timestamp = obj.mp4StreamOption.timestamp;
            token = obj.mp4StreamOption.token;
            const html5ApiUrl = 'https://nfg1vss.webex.com/apis/html5-pipeline.do?recordingDir=' + recordingDir + '&timestamp=' + timestamp + '&token=' + token + '&xmlName=recording.xml';
            try {
                var options = {
                    url: html5ApiUrl,
                };
                var xmlResponse = await doRequest(options);
                const jsonObj = await xmlToJSON(xmlResponse, {});
                filename = jsonObj.HTML5Pipeline.RecordingXML[0].Screen[0].Sequence[0]._;
                if (!filename.endsWith(".mp4")) {
                    throw new Error("Invalid filename in XML");
                }
            } catch (e) {
                newAPI = true;
            }
        } else {
            newAPI = true;
        }

        if (newAPI) {
            const hasMp4Url = obj.downloadRecordingInfo && obj.downloadRecordingInfo.downloadInfo && "mp4URL" in obj.downloadRecordingInfo.downloadInfo;
            if (hasMp4Url || "fallbackPlaySrc" in obj) {
                term.yellow('\nUsing new API version');
            } else {
                term.red('\nCan\'t get current video XML-URL. Going to the next one.\n');
                notDownloaded.push(videoUrl);
                continue;
            }
        }

        var mp4DirectDownloadUrl_slow;
        if (newAPI) {
            if (obj.downloadRecordingInfo && obj.downloadRecordingInfo.downloadInfo && "mp4URL" in obj.downloadRecordingInfo.downloadInfo)
                mp4DirectDownloadUrl_slow = obj.downloadRecordingInfo.downloadInfo.mp4URL;
            else
                mp4DirectDownloadUrl_slow = obj.fallbackPlaySrc;
        }
        else {
            mp4DirectDownloadUrl_slow = 'https://nfg1vss.webex.com/apis/download.do?recordingDir=' + recordingDir + '&timestamp=' + timestamp + '&token=' + token + '&fileName=' + filename;
        }

        const mp4DirectDownloadUrl_fast = obj.fallbackPlaySrc;     // new endpoint that can be (ab)used to download the video --> really fast if works, since WebEx itself provides Multithreading on this url
        var params = {
            mp4DirectDownloadUrl_slow: mp4DirectDownloadUrl_slow,
            mp4DirectDownloadUrl_fast: mp4DirectDownloadUrl_fast,
            title: title,
            videoUrl: videoUrl,
        }
        await directDownload(params);
    }

    if (notDownloaded.length > 0) {
        console.log(`\nThese videos have not been downloaded (${notDownloaded.length}/${videoUrls.length}):\n%s\n`, notDownloaded);
    } else {
        console.log(`\nAll ${videoUrls.length} requested videos have been downloaded!\n`);
    }
    term.green(`Done!\n`);
    if (argv.noToastNotification === false) {
        require('node-notifier').notify({
            title: 'PoliWebex',
            message: 'DONE! See logs on terminal.',
            appID: "https://nodejs.org/", // Such a smart assignment to avoid SnoreToast start menu link. Don't say to my mother.
        }, function (error, response) { /*console.log(response);*/ });
    }

}

async function login(credentials, browser) {
    let page;

    page = (await browser.pages())[0]; // in non-headless mode, there is already a blank page. Reuse it
    if (page == null) { page = await browser.newPage(); } // safe check

    await page.setViewport({ width: 1366, height: 768 }); //set viewport size to enable QR code login on posteID
    console.log('Navigating to WebEx login page...');
    await page.goto('https://politecnicomilano.webex.com/mw3300/mywebex/login/login.do?siteurl=politecnicomilano-it&viewFrom=modern', {
        waitUntil: 'networkidle2'
    });

    await page.waitForSelector('input[type="email"]');
    await page.keyboard.type(credentials.email);
    await page.click('button[name="btnOK"]');

    console.log('Filling in Servizi Online login form...');
    try {
        await page.waitForSelector('input[id="login"]');
    } catch (error) {
        term.red("Timeout from attempting to login. We're already in non-headless mode, so we're kinda screwed.");
        process.exit(4);
    }
    await page.waitForSelector('#spid-idp-button-medium-post');
    await page.click('a[class="italia-it-button ingresso-federato-button-size-m button-spid"]');



    //const button = await page.$('button[name="evn_conferma"]');
    //await button.evaluate(b => b.click()); // clicca sul tasto "Accedi"
    var loginHandling = { "unInput": "username", "pwInput": "password" };
    await browser.waitForTarget(target => {
        var result = isSPIDPage(target.url());
        if (result === true) {
            console.log("No overrides.");
            return true;
        }
        else if (result.hasOwnProperty("pwInput")) {
            loginHandling = result;
            console.log("Overrides.");
            return true;
        }
    }, {
        timeout: 900000
    });

    var handler = page;
    if (loginHandling.hasOwnProperty("iframe")) {
        await page.waitForSelector(loginHandling.iframe);
        const elementHandle = await page.$('div#content iframe');
        handler = await elementHandle.contentFrame();
    }

    await handler.waitForSelector('input[id="' + loginHandling.unInput + '"]');

    await handler.type('input[id="' + loginHandling.unInput + '"]', credentials.SPIDusername)
    await handler.type('input[id="' + loginHandling.pwInput + '"]', credentials.password)

    console.log("input username&pw successfully");


    try {
        await page.waitForSelector('div[class="poli-messages"] > div[class="alert alert-danger"]', {
            timeout: 1000 * timeout
        });
        term.red('Must\'ve clicked on the polimi login button. Error.');
        process.exit(401);
    } catch (error) {
        // tutto ok
    }

    await browser.waitForTarget(target => target.url().includes("polimi.it"), {	//Wait until the user hands control back to polimi
        timeout: 9000000
    });

    try {
        await page.waitForSelector('button[name="evn_continua"]', {
            timeout: 1000 * timeout
        }); // password is expiring
        const button = await page.$('button[name="evn_continua"]');
        await button.evaluate(b => b.click()); // clicca sul tasto "Continua"
    } catch (error) {
        // password is not expiring
    }

    try {
        await page.waitForSelector('#dati_applicativi_autorizzazioniXSceltaMatricolaColl', {
            timeout: 2000 * timeout
        });
        await page.click('#dati_applicativi_autorizzazioniXSceltaMatricolaColl > tbody > tr:nth-child(1) > td:nth-child(1) > a'); // clicca sulla prima matricola
    } catch (error) {
        // scelta della matricola non apparsa, ok...
    }

    var currentIndex = 0;

    await browser.waitForTarget(target => target.url().includes('politecnicomilano.webex.com/'), {
        timeout: 90000
    });
    console.log('We are logged in. ');
    return page;
}

function isSPIDPage(targetSite) {
    console.log("Checking target...")
    console.log(targetSite)
    const targets = [
        "infocert.it",
        "poste.it",
        "tim.it",
        "sieltecloud.it",
        "aruba.it",
        "namirialtsp.com",
        "register.it",
        "intesa.it",
        "lepida.it",
    ];

    const overrides = [
        {
            "site": "tim.it",
            "unInput": "userid",
            "pwInput": "PASSWORD",
            "iframe": "iframe"
        },
        {
            "site": "namirialtsp.com",
            "unInput": "input_username",
            "pwInput": "input_password"
        },
        {
            "site": "intesa.it",
            "unInput": "MainContent_LoginForm_nome_utente",
            "pwInput": "MainContent_LoginForm_password"
        },
    ];

    for (const site of targets) {
        if (targetSite.includes(site) && !targetSite.includes("spid.polimi.it/spidlogin")) {
            console.log("Match found");
            var override = overrides.filter(o => o.site === site)
            if (override.length > 0) {
                return override[0];
            }
            else
                return true;
        }
    }
    return false;
}

async function directDownload(params) {
    let times = 5;
    var count = 0;
    while (count < times) { // make aria2 multithreading download more consistent and reliable
        try {

            // download async. I'm Speed
            const fullTitle = params.title + '.mp4';
            let mp4DirectDownloadUrl
            if (count < 2) {
                mp4DirectDownloadUrl = params.mp4DirectDownloadUrl_fast
            } else {
                term.yellow('Switching to fallback download URL, slower...\n\n');
                mp4DirectDownloadUrl = params.mp4DirectDownloadUrl_slow // fallback on slow url if the fast one doesn't work multiple times
            }
            const aria2cArgs = ['-j', '16', '-x', '16', '-d', argv.outputDirectory, '-c', '-o', fullTitle, mp4DirectDownloadUrl];
            const result = spawnSync('aria2c', aria2cArgs, { stdio: 'inherit' });
            if (result.status !== 0) {
                throw new Error(`aria2c failed with exit code ${result.status}`);
            }
        } catch (e) {
            term.yellow('\n\nOops! We lost some video fragment! Trying one more time...\n\n');
            count++;
            continue;
        }
        break;
    }
    if (count == times) {
        term.red('\nPersistent errors during the download of the current video. Going to the next one.\n');
        notDownloaded.push(params.videoUrl);
        return;
    }
    return;
}

async function extractRecmanUrls(videoUrls) {
    let videoUrlObj;
    const aunicaUrls = [];
    for (let videoUrl of videoUrls) {
        if (videoUrl == "") continue; // jump empty url

        videoUrlObj = new URL(videoUrl)
        if (videoUrlObj.host == 'aunicalogin.polimi.it' || videoUrlObj.host == 'webeep.polimi.it') {       // https://aunicalogin.polimi.it/aunicalogin/getservizio.xml?id_servizio=2294&c_classe_webeep=768632-STD || https://webeep.polimi.it/course/view.php?id=1322&section=3
            aunicaUrls.push(videoUrl)
        }
    }

    return aunicaUrls
}

function promptArchiveSelection(question, archiveCount) {
    const readline = require('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise(function (resolve) {
        var ask = function () {
            rl.question(question, function (answer) {
                const trimmed = answer.trim();
                // Default or 0 or 'all': select all archives (indices 0 to archiveCount - 1)
                if (trimmed === "" || trimmed === "0" || trimmed.toLowerCase() === "all") {
                    rl.close();
                    const allIndices = Array.from({ length: archiveCount }, (_, i) => i);
                    resolve(allIndices);
                    return;
                }

                // Parse space-separated or comma-separated tokens
                const tokens = trimmed.split(/[\s,]+/).filter(t => t.length > 0);
                const selected = [];
                let valid = true;

                for (const t of tokens) {
                    const num = parseInt(t, 10);
                    if (isNaN(num) || num < 1 || num > archiveCount) {
                        valid = false;
                        break;
                    }
                    const idx = num - 1; // 1-based to 0-based index
                    if (!selected.includes(idx)) {
                        selected.push(idx);
                    }
                }

                if (valid && selected.length > 0) {
                    rl.close();
                    selected.sort((a, b) => a - b);
                    resolve(selected);
                } else {
                    term.red(`\nInvalid selection. Please enter numbers between 1 and ${archiveCount} (separated by space) or 0 for all [default: 0]\n`);
                    ask();
                }
            });
        };
        ask();
    });
}

async function handleWebeepLoginIfPresent(page) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            if (page.url().includes('login/index.php')) {
                const xpath_auth = "//a[contains(@href, 'auth')]";
                await page.waitForXPath(xpath_auth, { timeout: 8000 }).catch(() => null);
                const buttons = await page.$x(xpath_auth);
                if (buttons.length > 0) {
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 * timeout }).catch(() => {}),
                        buttons[0].click()
                    ]);
                }
            }
        } catch (e) {
            // WeBeep login not needed or already completed
        }
    }
}

async function findRecordingArchives(page) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await sleep(1000);
            await page.waitForSelector('body', { timeout: 10000 }).catch(() => {});
            return await page.evaluate(() => {
                const anchors = Array.from(document.querySelectorAll('a'));
                const candidates = [];

                for (const a of anchors) {
                    const href = (a.href || '').trim();
                    const text = (a.innerText || a.textContent || '').trim();
                    const textLower = text.toLowerCase();

                    // Check if link points to a Moodle activity or direct launch
                    const isActivityLink = href.includes('/mod/url/view.php') || 
                                           href.includes('aunicalogin.polimi.it/aunicalogin/getservizio.xml') ||
                                           href.includes('recman');

                    if (!isActivityLink) continue;

                    // Check keyword in link text (case-insensitive)
                    const hasKeyword = textLower.includes('registrazion') || 
                                       textLower.includes('recording') || 
                                       textLower.includes('recman') ||
                                       textLower.includes('webex');

                    // Or check if this link is located inside a section titled "Registrazioni" / "Recordings"
                    let inRecordingSection = false;
                    let parent = a.closest('.section, .course-section, section, div.section-summary, div.content, li.section, div.activity');
                    if (parent) {
                        const parentText = (parent.innerText || parent.textContent || '').toLowerCase();
                        if (parentText.includes('registrazion') || parentText.includes('recording')) {
                            inRecordingSection = true;
                        }
                    }

                    if (hasKeyword || inRecordingSection) {
                        let title = text.replace(/\s+/g, ' ').trim();
                        if (!title && parent) {
                            title = (parent.innerText || parent.textContent || '').replace(/\s+/g, ' ').trim();
                        }
                        candidates.push({
                            title: title || 'Archivio Registrazioni',
                            href: href,
                            sectionUrl: window.location.href
                        });
                    }
                }

                // Deduplicate candidates by href (ignoring hash)
                const unique = [];
                const seen = new Set();
                for (const c of candidates) {
                    const normHref = c.href.split('#')[0];
                    if (!seen.has(normHref)) {
                        seen.add(normHref);
                        unique.push({
                            title: c.title,
                            href: normHref,
                            sectionUrl: c.sectionUrl
                        });
                    }
                }
                return unique;
            });
        } catch (err) {
            if (err.message && err.message.includes('Execution context was destroyed')) {
                await sleep(2000);
                await handleWebeepLoginIfPresent(page);
                continue;
            }
            throw err;
        }
    }
    return [];
}

async function getArchivesFromWebeepCourse(page, courseUrl) {
    await page.goto(courseUrl, { waitUntil: 'networkidle2' });
    await sleep(1000);
    await handleWebeepLoginIfPresent(page);

    // Search for archives on the course page (case-insensitive & section-aware)
    let archives = await findRecordingArchives(page);

    // If not found and url did not have section, try &section=3 as fallback
    if (archives.length === 0 && !courseUrl.includes('section=')) {
        const section3Url = courseUrl + (courseUrl.includes('?') ? '&' : '?') + 'section=3';
        await page.goto(section3Url, { waitUntil: 'networkidle2' });
        await sleep(1000);
        await handleWebeepLoginIfPresent(page);
        archives = await findRecordingArchives(page);
    }

    if (!archives || archives.length === 0) {
        term.red("\nCan't get the RecMan url. Did you submit the correct WeBeep link?\n");
        return [];
    }

    if (archives.length === 1) {
        term.yellow(`\nFound 1 recording archive on WeBeep: ${archives[0].title}\n`);
        return archives;
    }

    // Multiple archives found
    term.yellow(`\nFound ${archives.length} recording archives on WeBeep:\n`);
    term.cyan(`  [0] Download ALL archives (${archives.length} archives)\n`);
    for (let i = 0; i < archives.length; i++) {
        term.cyan(`  [${i + 1}] ${archives[i].title}\n`);
    }

    let selectedIndices = [];
    if (argv.archive !== undefined) {
        const val = String(argv.archive).trim();
        if (val === "0" || val.toLowerCase() === "all") {
            selectedIndices = Array.from({ length: archives.length }, (_, i) => i);
        } else {
            const tokens = val.split(/[\s,]+/).filter(t => t.length > 0);
            for (const t of tokens) {
                const num = parseInt(t, 10);
                if (!isNaN(num) && num >= 1 && num <= archives.length) {
                    const idx = num - 1;
                    if (!selectedIndices.includes(idx)) selectedIndices.push(idx);
                }
            }
        }
    }
    if (selectedIndices.length === 0) {
        selectedIndices = await promptArchiveSelection(
            `Select archives to download (space-separated, e.g. 1 2, or 0 for all) [default: 0]: `,
            archives.length
        );
    }

    term.yellow(`\nSelected ${selectedIndices.length} archive(s) for download.\n`);
    return selectedIndices.map(idx => archives[idx]);
}

async function extractRecordingsUrl(aunicalogin_url) {
    var page;
    const webexUrls = [];
    if (browser == null) {
        var credentials = await askForCredentials(argv.SPIDpassword);
        await openBrowser();
        page = await login(credentials, browser);
        await sleep(3000 * timeout);
        const cookie = await extractCookies(page); // update WebEx cookies while we're at it.
        await saveCookies(cookie);
    } else {
        page = (await browser.pages())[0];
    }

    term.yellow('\nExtracting WebEx recordings from ' + aunicalogin_url + '\nThis could take a while...\n');

    let targetArchives = [];
    let parsedUrl;
    try {
        parsedUrl = new URL(aunicalogin_url);
    } catch (e) {
        parsedUrl = null;
    }

    const isCourseUrl = parsedUrl && parsedUrl.host === 'webeep.polimi.it' && !aunicalogin_url.includes('/mod/url/view.php');

    if (isCourseUrl) {
        targetArchives = await getArchivesFromWebeepCourse(page, aunicalogin_url);
        if (!targetArchives || targetArchives.length === 0) {
            return webexUrls;
        }
    } else {
        targetArchives = [{
            title: aunicalogin_url,
            href: aunicalogin_url
        }];
    }

    for (let aIdx = 0; aIdx < targetArchives.length; aIdx++) {
        const target = targetArchives[aIdx];
        if (targetArchives.length > 1) {
            term.yellow(`\n[Archive ${aIdx + 1}/${targetArchives.length}] Opening ${target.title}...\n`);
        } else {
            term.yellow(`\nOpening ${target.title}...\n`);
        }
        term.gray(`Target URL: ${target.href}\n`);

        let recmanPage = null;

        // If target was discovered on a WeBeep course page, navigate to its section page and click the card.
        // This triggers Moodle's popup opening mechanism directly, correctly separating different academic years.
        if (isCourseUrl) {
            try {
                const sectionPageUrl = target.sectionUrl || aunicalogin_url;
                if (!page.url().includes(sectionPageUrl)) {
                    term.gray(`Navigating to archive section page: ${sectionPageUrl}\n`);
                    await page.goto(sectionPageUrl, { waitUntil: 'networkidle2' });
                    await sleep(1000);
                    await handleWebeepLoginIfPresent(page);
                }

                // Listen for any new tab (popup) created by clicking the card
                const targetPromise = browser.waitForTarget(
                    t => t.type() === 'page' && t !== page.target(),
                    { timeout: 8000 }
                ).catch(() => null);

                const idMatch = target.href.match(/id=(\d+)/);
                const actId = idMatch ? idMatch[1] : null;

                // Find clickable card or link inside the activity container
                let cardEl = null;
                if (actId) {
                    const handles = await page.$x(`//li[contains(@id, "${actId}")]//a | //div[contains(@data-id, "${actId}")]//a`);
                    if (handles.length > 0) cardEl = handles[0];
                }
                if (!cardEl && target.title) {
                    const xpath = `//a[contains(., "${target.title.replace(/"/g, '')}")]`;
                    const handles = await page.$x(xpath);
                    if (handles.length > 0) cardEl = handles[0];
                }

                let cardClicked = false;
                if (cardEl) {
                    term.gray(`Found card for ${target.title}, clicking on WeBeep course/section page...\n`);
                    await cardEl.evaluate(el => el.scrollIntoView({ block: 'center' }));
                    await sleep(300);
                    await cardEl.click().catch(() => {});
                    cardClicked = true;
                }

                if (cardClicked) {
                    const popupTarget = await targetPromise;
                    if (popupTarget) {
                        term.green(`Successfully caught popup tab!\n`);
                        recmanPage = await popupTarget.page();
                        await recmanPage.bringToFront().catch(() => {});
                    }
                }
            } catch (err) {
                term.gray(`Notice: card click failed (${err.message}), falling back to direct navigation...\n`);
            }
        }

        // Fallback: navigate directly with redirect=1 or resolve launchUrl
        if (!recmanPage) {
            const directUrl = target.href.includes('redirect=') ? target.href : `${target.href}${target.href.includes('?') ? '&' : '?'}redirect=1`;
            term.gray(`Direct navigating to: ${directUrl}\n`);
            await page.goto(directUrl, { waitUntil: 'networkidle2' });
            await sleep(1000);
            await handleWebeepLoginIfPresent(page);

            // If still on WeBeep (e.g. Moodle didn't auto-redirect and showed the fallback page)
            if (page.url().includes('webeep.polimi.it')) {
                term.gray(`Still on WeBeep (${page.url()}), checking for launch link...\n`);

                // Save page HTML for diagnosis
                try {
                    const htmlContent = await page.content();
                    fs.writeFileSync(`webeep_debug_archive_${aIdx + 1}.html`, htmlContent, 'utf8');
                    term.gray(`Saved page HTML to webeep_debug_archive_${aIdx + 1}.html\n`);
                } catch (e) {}

                // Dump all matching URLs in page
                const pageUrls = await page.evaluate(() => {
                    const html = document.documentElement.innerHTML;
                    const matches = html.match(/https:\/\/[^"'\s<>]+/g) || [];
                    return [...new Set(matches)].filter(u => u.includes('aunicalogin') || u.includes('recman') || u.includes('classe'));
                });
                term.gray(`All Aunicalogin/RecMan URLs in page:\n  ${pageUrls.join('\n  ')}\n`);

                const launchUrl = await page.evaluate(() => {
                    const contentArea = document.getElementById('page-content') || 
                                        document.getElementById('region-main') || 
                                        document.querySelector('.urlworkaround, main, [role="main"]') || 
                                        document.body;
                    const anchors = Array.from(contentArea.querySelectorAll('a'));

                    const recman2294 = anchors.find(a => a.href && a.href.includes('getservizio.xml') && a.href.includes('id_servizio=2294'));
                    if (recman2294) return recman2294.href;

                    const classeAnchor = anchors.find(a => a.href && a.href.includes('getservizio.xml') && a.href.includes('c_classe_webeep'));
                    if (classeAnchor) return classeAnchor.href;

                    const fallback = anchors.find(a => a.href && a.href.includes('aunicalogin.polimi.it/aunicalogin/getservizio.xml'));
                    return fallback ? fallback.href : null;
                });

                term.gray(`Found launchUrl: ${launchUrl}\n`);
                if (launchUrl) {
                    await page.goto(launchUrl, { waitUntil: 'networkidle2' });
                }
            }

            recmanPage = page;
            if (!page.url().includes('recman_frontend')) {
                const recmanTarget = await browser.waitForTarget(
                    t => t.url().includes('recman_frontend'),
                    { timeout: 30000 }
                ).catch(() => null);
                if (recmanTarget) {
                    recmanPage = (await recmanTarget.page()) || page;
                }
            }
        }

        // Wait for RecMan to complete navigation/redirection
        if (!recmanPage.url().includes('recman_frontend')) {
            await recmanPage.waitForFunction(
                () => window.location.href.includes('recman_frontend') || window.location.href.includes('Brain.do'),
                { timeout: 30000 }
            ).catch(() => null);
        }

        if (recmanPage.url().includes('Brain.do') || recmanPage.url().includes('configuratorefaq')) {
            const pageText = await recmanPage.evaluate(() => document.body.innerText).catch(() => 'Unable to read body');
            term.red(`\n================== [POLIMI ERROR DETAILS] ==================\n`);
            term.red(`URL: ${recmanPage.url()}\n`);
            term.red(`Page text:\n${pageText.trim()}\n`);
            term.red(`============================================================\n`);
            if (recmanPage !== page) {
                await recmanPage.close().catch(() => {});
            }
            continue;
        }

        await recmanPage.bringToFront().catch(() => {});
        try { await recmanPage.waitForSelector("table, a", { timeout: 15000 }).catch(() => {}); } catch (e) {}

        // Check if there is an action=plen_0 link to display all recordings on a single page
        try {
            const plen0 = await recmanPage.evaluate(() => {
                const a = Array.from(document.querySelectorAll("a")).find(el => el.href && el.href.includes("action=plen_0"));
                return a ? a.href : null;
            });
            if (plen0) {
                term.cyan("Navigating to show ALL course recordings (plen_0)...\n");
                await recmanPage.goto(plen0, { waitUntil: "networkidle2" });
                await recmanPage.waitForSelector("table, a", { timeout: 15000 }).catch(() => {});
            }
        } catch (e) {}

        let previewLinks = await recmanPage.evaluate(() => {
            let elements = Array.from(document.querySelectorAll("a"));
            let links = elements.map(el => el.href).filter(h => h && (
                h.includes("evn_preview_link") || 
                h.includes("RedirectToWebEx") || 
                h.includes("webex.com")
            ));
            return [...new Set(links)];
        });

        term.green(`Found ${previewLinks.length} preview links on RecMan for: ${target.title}\n`);

        let archiveWebex = 0;
        let archiveSharepoint = 0;

        for (let i = 0; i < previewLinks.length; i++) {
            const link = previewLinks[i];
            if (link.includes("webex.com")) {
                webexUrls.push(link);
                archiveWebex++;
                continue;
            }
            let tab = null;
            try {
                tab = await browser.newPage();
                await tab.goto(link, { waitUntil: "domcontentloaded", timeout: 30000 });
                await tab.waitForFunction(
                    () => window.location.href.includes("webex.com") || window.location.href.includes("sharepoint.com") || window.location.href.includes("polimi365"),
                    { timeout: 8000 }
                ).catch(() => {});
                const finalUrl = tab.url();
                if (finalUrl.includes("webex.com")) {
                    term.gray(`[${i + 1}/${previewLinks.length}] Resolved: ${finalUrl}\n`);
                    webexUrls.push(finalUrl);
                    archiveWebex++;
                } else if (finalUrl.includes("sharepoint.com") || finalUrl.includes("polimi365") || finalUrl.includes("microsoftstream")) {
                    const cleanUrl = finalUrl.split('&access_token')[0];
                    term.yellow(`[${i + 1}/${previewLinks.length}] SharePoint/Teams recording detected (WebEx download unsupported): ${cleanUrl}\n`);
                    archiveSharepoint++;
                } else {
                    const html = await tab.content();
                    const m = html.match(/https:\/\/[^"'\s<>]*webex\.com\/[^"'\s<>]*/);
                    if (m) {
                        term.gray(`[${i + 1}/${previewLinks.length}] Extracted: ${m[0]}\n`);
                        webexUrls.push(m[0]);
                        archiveWebex++;
                    } else {
                        term.yellow(`[${i + 1}/${previewLinks.length}] Warning: could not resolve WebEx URL from preview link (${finalUrl.split('?')[0]}).\n`);
                    }
                }
            } catch (e) {
                term.red(`[${i + 1}/${previewLinks.length}] Failed resolving link: ${e.message}\n`);
            } finally {
                if (tab) {
                    await tab.close().catch(() => {});
                }
            }
        }

        term.cyan(`Archive summary for "${target.title}": ${archiveWebex}/${previewLinks.length} WebEx recordings resolved`);
        if (archiveSharepoint > 0) {
            term.yellow(` (${archiveSharepoint} SharePoint/Teams recordings excluded)`);
        }
        term.cyan(`\n`);

        // Close the RecMan tab if it was opened in a separate tab, keeping main page on the course page
        if (recmanPage !== page) {
            await recmanPage.close().catch(() => {});
        }
    }

    const uniqueWebexUrls = [...new Set(webexUrls)];
    term.green(`\nTotal WebEx recordings ready for download: ${uniqueWebexUrls.length}\n`);
    return uniqueWebexUrls;
}

async function getCookies(password) {
    let cookie = await getSavedCookies()
    let isValidCookie = await checkCookieValidity(cookie)
    if (cookie != null && isValidCookie) {
        term.brightBlue('Reusing saved cookies. No login required this time :)\n');
    } else {
        cookie = getNewCookies(password)
    }
    return cookie;
}

async function getSavedCookies() {
    return await getConfig('cookie')
}

async function checkCookieValidity(cookie) {
    const checkUrl = 'https://politecnicomilano.webex.com/webappng/api/v1/pmrs/recent' // use an endpoint that requires valid cookies
    var options = {
        url: checkUrl,
        headers: { 'Cookie': cookie, }
    };
    try {
        var response = await doRequest(options)
        try {
            var obj = JSON.parse(response)
            term.yellow("Cookie is valid\n");
            return true //Must be a valid json entry.
        } catch (e) {
            term.red("Cookie is not valid\n");
        }

    } catch (e) {
        //console.log(e.statusCode)
    }
    return false
}

async function getNewCookies(password) {
    var credentials = await askForCredentials(password);
    await openBrowser()

    if (argv.timeout !== undefined) {
        timeout = argv.timeout;
    }

    var page = await login(credentials, browser);
    await sleep(3000 * timeout)
    const cookie = await extractCookies(page)
    //console.log(cookie);
    await saveCookies(cookie)
    console.log('Got required authentication cookies.');
    console.log("\nAt this point Chrome's job is done, shutting it down...");
    await browser.close(); // browser is no more required. Free up RAM!
    return cookie;
}

async function saveCookies(cookies) {
    await addConfig('cookie', cookies)
}

async function extractCookies(page) {
    var jar = await page.cookies("https://.webex.com");
    var ticketCookie = jar.filter(c => c.name === 'ticket')[0];
    if (ticketCookie == null) {
        await sleep(5000);
        var jar = await page.cookies("https://.webex.com");
        var tiketCookie = jar.filter(c => c.name === 'ticket')[0];
    }
    if (ticketCookie == null) {
        console.error('Unable to read cookies. Try launching one more time, this is not an exact science.');
        process.exit(88);
    }
    return `ticket=${ticketCookie.value}`;
}

async function extractJSESSIONCookie(page) {
    var jar = await page.cookies();
    var sessionCookie = jar.find(c => c.name === 'SSL_JSESSIONID') || jar.find(c => c.name === 'JSESSIONID') || jar[0];
    if (sessionCookie == null) {
        await sleep(5000);
        var jar = await page.cookies();
        var sessionCookie = jar.find(c => c.name === 'SSL_JSESSIONID') || jar.find(c => c.name === 'JSESSIONID') || jar[0];
    }
    if (sessionCookie == null) {
        term.red('Unable to read session cookie. Try launching one more time, this is not an exact science.\n');
        process.exit(88);
    }
    return jar.map(c => `${c.name}=${c.value}`).join('; ');
}




async function askForCredentials(password) {

    var SPIDusername = (argv.SPIDusername === undefined) ? '' : argv.SPIDusername;
    var email = (argv.polimiEmail === undefined) ? '' : argv.polimiEmail;
    var changed = false;
    var info = {}

    if (fs.existsSync('config.json')) {
        let rawdata = fs.readFileSync('config.json');
        info = JSON.parse(rawdata);

        if (SPIDusername !== '') {
            info.SPIDusername = SPIDusername;
            changed = true;
        } else if (info.hasOwnProperty('SPIDusername')) {
            SPIDusername = info.SPIDusername;
        } else {
            SPIDusername = await promptQuestion("SPID username/e-mail not saved. Please enter your SPID username/e-mail, PoliWebex will not ask for it next time: ");
            info.SPIDusername = SPIDusername;
            changed = true;
        }

        if (email !== '') {
            info.email = email;
            changed = true;
        } else if (info.hasOwnProperty('email')) {
            email = info.email;
        } else {
            email = await promptQuestion("PoliMi email not saved. Please enter your PoliMi email, in format \"name.surname@mail.polimi.it\", PoliWebex will not ask for it next time: ");
            info.email = email;
            changed = true;
        }
    } else {
        if (SPIDusername === '') {
            SPIDusername = await promptQuestion("SPID username/e-mail not saved. Please enter your SPID username/e-mail, PoliWebex will not ask for it next time: ");
        }
        info.SPIDusername = SPIDusername;

        if (email === '') {
            email = await promptQuestion("Email not saved. Please enter your PoliMi email, in format \"name.surname@mail.polimi.it\", PoliWebex will not ask for it next time: ");
        }
        info.email = email;

        changed = true;
    }

    // handle password
    const keytar = require('keytar');
    //keytar.deletePassword('PoliWebex', username);
    if (password === undefined) { // password not passed as argument
        var password = {};
        if (argv.noKeyring === false) {
            try {
                await keytar.getPassword("PoliWebexSPID", info.SPIDusername).then(function (result) {
                    password = result;
                });
                if (password === null) { // no previous password saved
                    password = await promptPassword("Password not saved. Please enter your SPID password, PoliWebex will not ask for it next time: ");
                    await keytar.setPassword("PoliWebexSPID", info.SPIDusername, password);
                    info.passwordSaved = true;
                    changed = true;
                } else {
                    console.log("Reusing password saved in system's keychain!")
                }
            } catch (e) {
                console.log("X11 is not installed on this system. PoliWebex can't use keytar to save the password.")
                password = await promptPassword("No problem, please manually enter your password: ");
            }
        } else {
            password = await promptPassword("Please enter your password: ");
        }
    } else {
        if (argv.noKeyring === false) {
            try {
                await keytar.setPassword("PoliWebexSPID", info.SPIDusername, password);
                console.log("Your password has been saved. Next time, you can avoid entering it!");
                info.passwordSaved = true;
                changed = true;
            } catch (e) {
                // X11 is missing. Can't use keytar
            }
        }
    }

    if (changed) {
        info.SPID = true;
        var json = JSON.stringify(info, null, 4);
        fs.writeFileSync('config.json', json);
    }

    info.password = password;
    return info;
}


async function addConfig(key, value) {
    var info = {}

    if (fs.existsSync('config.json')) {
        let rawdata = fs.readFileSync('config.json');
        info = JSON.parse(rawdata)
    }

    info[key] = value
    var json = JSON.stringify(info, null, 4);
    fs.writeFileSync('config.json', json);
}

async function getConfig(key) {
    if (fs.existsSync('config.json')) {
        let rawdata = fs.readFileSync('config.json');
        var info = JSON.parse(rawdata);

        if (info.hasOwnProperty(key)) {
            return info[key]
        }
    }
    return null;
}

async function openBrowser() {
    if (browser !== null) { return; } // browser already running
    console.log('\nLaunching Chrome to perform the OpenID Connect dance...');

    var executablePath =
        process.env.PUPPETEER_EXECUTABLE_PATH ||
        (process.pkg
            ? path.join(
                path.dirname(process.execPath),
                'puppeteer',
                ...puppeteer
                    .executablePath()
                    .split(path.sep)
                    .slice(puppeteer.executablePath().split(path.sep).indexOf('.local-chromium') + 1), // /snapshot/project/node_modules/puppeteer/.local-chromium
            )
            : puppeteer.executablePath());

    browser = await puppeteer.launch({
        executablePath: executablePath,
        headless: false,
        args: ['--disable-dev-shm-usage', '--lang=it-IT', '--disable-popup-blocking']
    });
}


function doRequest(options) {
    return doRequestMain(options, false)
}

function doRequestAccept404(options) {
    return doRequestMain(options, true)
}

function doRequestMain(options, accept404) {
    return new Promise(function (resolve, reject) {
        request(options, function (error, res, body) {
            if (!error && (res.statusCode == 200 || res.statusCode == 403 || (accept404 && res.statusCode == 404))) {
                resolve(body);
            } else {
                if (!error) { // not an error but statusCode is not in the accepted ones
                    reject({ statusCode: res.statusCode });
                } else {
                    reject(error);
                }

            }
        });
    });
}

function xmlToJSON(str, options) {
    return new Promise((resolve, reject) => {
        xml2js.parseString(str, options, (err, jsonObj) => {
            if (err) {
                return reject(err);
            }
            resolve(jsonObj);
        });
    });
}

function extractVideoID(videoUrl) {
    var url = new URL(videoUrl);
    var pathnameArray = url.pathname.split('/');
    for (let part of pathnameArray) {
        if (part.length == 32) {
            return part;
        }
        else if (part.length > 32) {
            var char32 = part.slice(0, 32)
            if (char32.match(/^[a-z0-9]+$/i)) // first 32 char are alphanumeric
                return char32;
        }
    }
    return null;
}

function extractRCID(videoUrl) {
    var url = new URL(videoUrl);
    return url.searchParams.get("RCID") || url.searchParams.get("rcid");
}

function getRedirectUrl(options) {
    return new Promise(function (resolve, reject) {
        const reqOptions = Object.assign({}, options, { followRedirect: false });
        request(reqOptions, function (error, res, body) {
            if (error) return reject(error);
            if (res.headers && res.headers.location) {
                return resolve(res.headers.location);
            }
            if (body) {
                const m = body.match(/location\.href\s*=\s*['"](.*?)['"];?/i);
                if (m && m[1]) return resolve(m[1]);
            }
            if (res.request && res.request.uri && res.request.uri.href) {
                return resolve(res.request.uri.href);
            }
            resolve(null);
        });
    });
}
function promptChoice(question, count) {
    const readline = require('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise(function (resolve, reject) {
        var ask = function () {
            rl.question(question, function (answer) {
                if (!isNaN(answer) && parseInt(answer) < count && parseInt(answer) >= 0) {
                    resolve(parseInt(answer), reject);
                    rl.close();
                } else {
                    console.log("\n* Wrong * - Please enter a number between 0 and " + (count - 1) + "\n");
                    ask();
                }
            });
        };
        ask();
    });
}

function promptQuestion(question) {
    const readline = require('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise(function (resolve, reject) {
        var ask = function () {
            rl.question(question, function (answer) {
                resolve(answer, reject);
                rl.close();
            });
        };
        ask();
    });
}

async function promptPassword(question) {
    if (process.stdin.isTTY) {
        term(question);
        const password = await term.inputField({ echoChar: '*' }).promise;
        term('\n');
        return password;
    }
    return await promptQuestion(question);
}


function rmDir(dir, rmSelf) {
    var files;
    rmSelf = (rmSelf === undefined) ? true : rmSelf;
    dir = dir + "/";
    try {
        files = fs.readdirSync(dir);
    } catch (e) {
        console.log("!Oops, directory not exist.");
        return;
    }
    if (files.length > 0) {
        files.forEach(function (x, i) {
            if (fs.statSync(dir + x).isDirectory()) {
                rmDir(dir + x);
            } else {
                fs.unlinkSync(dir + x);
            }
        });
    }
    if (rmSelf) {
        // check if caller wants to delete the directory or just the files in this directory
        fs.rmdirSync(dir);
    }
}


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


term.brightBlue(`Project powered by @sup3rgiu\nFeatures: PoliMi Autologin - Multithreading download\n`);
sanityChecks();
const videoUrls = parseVideoUrls(argv.videoUrls);
console.info('Video URLs: %s', videoUrls);
//console.info('Password: %s', argv.password);
console.info('Output Directory: %s\n', argv.outputDirectory);
downloadVideo(videoUrls, argv.SPIDpassword, argv.outputDirectory, argv.videoPwd);
