import { appendFile, readdir } from 'fs/promises';
import Bun from 'bun';
import data, { rootDir } from './config';
import { Info } from './lib/types';
import { run, parseDefaultArgs, sortResults, find, validate } from './lib/utils';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { render } from 'lib/utils/chart';

// Benchmark CLI
const tool = data.cli ||= 'bombardier';
const inTestMode = process.argv[2] === 'test';

// Destination file
const allResultsDir = `${rootDir}/results`,
    subResultDir = `${allResultsDir}/main`;

const desFile = `${allResultsDir}/index.md`,
    jsonResultFile = `${allResultsDir}/data.json`,
    compactResultFile = `${allResultsDir}/compact/compact.txt`,
    readmeFile = `${rootDir}/README.md`,
    templateFile = `${rootDir}/README.template.md`,
    debugFile = `${rootDir}/debug.log`;

// Prepare files
if (!inTestMode) {
    await Bun.write(desFile, `Bun: ${Bun.version}\n`);
    if (existsSync(debugFile)) rmSync(debugFile);
}

// Benchmark results
const results: number[] = [];

// Framework and test URLs
let frameworks = await readdir(`${rootDir}/src`);

if (data.include)
    // @ts-ignore
    frameworks = frameworks.filter(f => data.include.includes(f));
if (data.exclude)
    // @ts-ignore
    frameworks = frameworks.filter(f => !data.exclude.includes(f));

const urls = data.tests.map(v => {
    const arr: any[] = [v.path, v.method || 'GET'];
    if (v.bodyFile)
        arr.push(v.bodyFile);
    if (v.headers) {
        const headerArr: string[] = []
        for (const key in v.headers)
            headerArr.push('--header', `${key}: ${v.headers[key]}`);

        arr.push(headerArr);
    }

    return arr;
});

// Run scripts
if (!inTestMode) for (const script of data.scripts) {
    const args = [
        script.type || 'bun',
        `${rootDir}/scripts/${script.file}`
    ] as [string, string];

    console.log(args.join(' '));
    Bun.spawnSync(args, {
        stdout: 'inherit',
        env: {
            ROOT: rootDir,
            DES: desFile
        }
    });
}

const failedFramework: string[] = [];
function cleanup(server: Bun.Subprocess) {
    // Clean up
    server.kill();
    // @ts-ignore
    Bun.sleepSync(data.boot);
}

// Run benchmark
{
    data.boot ||= 5000;

    // Default arguments parsing
    const defaultArgs = parseDefaultArgs(data);

    // Run commands
    const commands = urls.map(v => {
        const arr = [tool, ...defaultArgs, 'http://localhost:3000' + v[0], '--method', v[1]];
        if (v[2])
            arr.push('--body-file', v[2]);
        if (v[3])
            arr.push(...v[3]);

        return arr;
    });

    for (let i = 0; i < frameworks.length; ++i) {
        const resultDir = `${subResultDir}/${frameworks[i]}`;
        if (!existsSync(resultDir))
            mkdirSync(resultDir);

        Bun.gc(true);

        const desDir = `${rootDir}/src/${frameworks[i]}`,
            info = await find(desDir + '/package.json') as Info;
        info.runtime ||= 'bun';

        if (info.version) {
            if (info.version === 'runtime')
                switch (info.runtime) {
                    case 'bun':
                        info.version = Bun.version;
                        break;
                    case 'node':
                        info.version = Bun.spawnSync(['node', '--version']).stdout.toString().substring(1).replace('\n', '');
                        break;
                    case 'deno':
                        let versionMsg = Bun.spawnSync(['deno', '--version']).stdout.toString().substring(5);
                        info.version = versionMsg.substring(0, versionMsg.indexOf(' '));
                        break;
                }
            frameworks[i] += ' ' + info.version;
        }

        const spawnOpts = {
            cwd: desDir,
            stdout: 'inherit',
            env: data.env
        } as any;

        // Build if a build script exists 
        if (info.build) Bun.spawnSync(info.build, spawnOpts);

        // Start the server command args
        info.main ||= 'index.ts';
        const args = info.run || (info.runtime === 'deno'
            ? ['deno', 'run', '--allow-net', '--unstable', info.main]
            : [info.runtime, `${desDir}/${info.main}`]
        );
        console.log(args.join(' '));

        // Boot up
        const server = Bun.spawn(args, spawnOpts);
        console.log('Booting', frameworks[i] + '...');
        Bun.sleepSync(data.boot);

        try {
            // Validate
            console.log('Validating...');
            if (!await validate(data.tests)) {
                console.log('The server does not pass the tests! Skip to the next one!');
                failedFramework.push(frameworks[i]);
                cleanup(server);
                continue;
            }
            Bun.gc(true);
            Bun.sleepSync(data.boot);

            // Only benchmark if not in test mode
            if (inTestMode) {
                cleanup(server);
                continue;
            }

            // Benchmark
            console.log('Benchmarking...');
            results.push(...await run(commands as any, resultDir));
        } catch (e) {
            console.log(frameworks[i], 'Crashed!');
            failedFramework.push(frameworks[i]);

            await appendFile(debugFile, frameworks[i] + ':\n' + String(e) + '\n\n');
        } finally {
            if (!server.killed) cleanup(server);
        }
    }
}

if (inTestMode)
    process.exit(0);

// Remove package.json dependencies field
{
    const pkgPath = rootDir + '/package.json',
        pkg = await import(pkgPath).then(v => v.default);

    pkg.dependencies = {};
    Bun.write(pkgPath, JSON.stringify(pkg, null, 4));
}

// Sort results
{
    if (failedFramework.length > 0) {
        console.log(`Frameworks that failed the test: ${failedFramework.join(', ')}.`);
        console.log('These frameworks will not be included in the result!');
        frameworks = frameworks.filter(v => !failedFramework.includes(v));
    } else console.log('All frameworks passed the boot-up test!');

    console.log('Sorting results...');

    const tableResultString = sortResults(frameworks, urls.length, results),
        resultTable = // Prepare table headers
            '| Name | Average | '
            + urls.map(v => `${v[1]} \`${v[0]}\``).join(' | ') + ' |\n| '
            // Split headers and results
            + ' :---: |'.repeat(urls.length + 2) + '\n'
            // All results
            + tableResultString.full;

    appendFile(desFile, resultTable);

    Bun.write(readmeFile, await Bun.file(templateFile).text() + '\n' + resultTable);
    Bun.write(compactResultFile, tableResultString.compact);
    Bun.write(jsonResultFile, JSON.stringify(tableResultString.json));

    render(`${allResultsDir}/chart.png`, tableResultString.json);
}
