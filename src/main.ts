import init, { greet } from '../wasm/pkg';

async function run() {
    await init();
    console.log(greet('Frogmarks'));
}

run();