import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename, join, resolve, sep } from 'node:path';

const RUNTIME_FILES = ['manifest.json', 'main.js', 'styles.css'];
const vaultArg = process.argv[2];

if (!vaultArg) {
	console.error('Usage: npm run install:vault -- "/path/to/your/vault"');
	process.exit(1);
}

const vaultPath = resolve(vaultArg);
const obsidianPath = join(vaultPath, '.obsidian');

if (!existsSync(obsidianPath)) {
	console.error(`No .obsidian folder found in ${vaultPath}`);
	process.exit(1);
}

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const pluginId = readPluginId(manifest);
const pluginsPath = join(obsidianPath, 'plugins');
const pluginPath = join(pluginsPath, pluginId);

assertSafePluginPath(pluginsPath, pluginPath);

mkdirSync(pluginsPath, { recursive: true });
removeExistingPlugin(pluginPath);
runBuild();
mkdirSync(pluginPath, { recursive: true });

for (const file of RUNTIME_FILES) {
	copyFileSync(file, join(pluginPath, basename(file)));
}

verifyInstall(pluginPath);

console.log(`Installed ${manifest.name} to ${pluginPath}`);
console.log('Removed the existing plugin folder before building.');
console.log('Verified copied files match the fresh build.');

function readPluginId(manifest) {
	if (typeof manifest.id !== 'string' || manifest.id.trim().length === 0) {
		console.error('manifest.json must contain a non-empty string id.');
		process.exit(1);
	}

	return manifest.id.trim();
}

function assertSafePluginPath(pluginsPath, pluginPath) {
	const resolvedPluginsPath = resolve(pluginsPath);
	const resolvedPluginPath = resolve(pluginPath);

	if (!resolvedPluginPath.startsWith(`${resolvedPluginsPath}${sep}`)) {
		console.error(`Refusing to install outside ${resolvedPluginsPath}`);
		process.exit(1);
	}
}

function removeExistingPlugin(pluginPath) {
	if (existsSync(pluginPath)) {
		console.log(`Removing existing plugin folder: ${pluginPath}`);
	} else {
		console.log(`No existing plugin folder found at: ${pluginPath}`);
	}

	rmSync(pluginPath, { recursive: true, force: true });

	if (existsSync(pluginPath)) {
		console.error(`Failed to remove existing plugin folder: ${pluginPath}`);
		process.exit(1);
	}
}

function runBuild() {
	const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

	try {
		execFileSync(npmCommand, ['run', 'build'], { stdio: 'inherit' });
	} catch (error) {
		console.error('Build failed after removing the existing plugin folder.');
		process.exit(readExitStatus(error));
	}
}

function verifyInstall(pluginPath) {
	for (const file of RUNTIME_FILES) {
		const sourcePath = resolve(file);
		const targetPath = join(pluginPath, basename(file));

		if (!existsSync(targetPath)) {
			console.error(`Install verification failed. Missing ${targetPath}`);
			process.exit(1);
		}

		if (sha256(sourcePath) !== sha256(targetPath)) {
			console.error(
				`Install verification failed. ${targetPath} differs from ${sourcePath}`,
			);
			process.exit(1);
		}
	}
}

function sha256(path) {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readExitStatus(error) {
	return typeof error?.status === 'number' ? error.status : 1;
}
