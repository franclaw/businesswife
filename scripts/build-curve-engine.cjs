// Node 24 development utility. The generated CommonJS engine runs on Node >=22.
const fs = require('node:fs');
const { stripTypeScriptTypes } = require('node:module');
const path = require('node:path');
const root = path.join(__dirname, '../games/vendor/zatacka');
const convert = name => stripTypeScriptTypes(fs.readFileSync(path.join(root, name + '.ts'), 'utf8'), { mode: 'transform' });
const constants = convert('constants').replace(/export /g, '');
const sim = convert('sim').replace(/import\s*\{[\s\S]*?\}\s*from\s*["']\.\/constants["'];?/, '').replace(/export /g, '');
fs.writeFileSync(path.join(root, 'engine.cjs'), '// Generated from Zatacka sim.ts and constants.ts; see LICENSE and README.\n' + constants + '\n' + sim + '\nmodule.exports={Sim,wormTemplate,FIELD_W,FIELD_H,PLAYER_COLORS,RADIUS,BORDER};\n');
