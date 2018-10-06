#!/usr/bin/env node
import chalk from 'chalk'
import { watch } from 'chokidar'
import execa from 'execa'
import got from 'got'
import { lstat, readdir, readFile, realpath } from 'mz/fs'
import * as path from 'path'
import getAuthToken from 'registry-auth-token'
// @ts-ignore
import getRegistryUrl from 'registry-auth-token/registry-url'
import * as semver from 'semver'
import signale from 'signale'
import { URL } from 'url'
import yargs from 'yargs'

interface PackageJson {
    version: string
    gitHead?: string
    dependencies: { [name: string]: string }
}

interface PackageMeta {
    name: string
    versions: { [version: string]: PackageJson }
}

const findRepoRoot = (packageRoot: string): Promise<string> =>
    execa.stdout('git', ['rev-parse', '--show-toplevel'], { cwd: packageRoot })

const shortenCommit = (commit: string): string => commit.substr(0, 7)

/**
 * Finds the closest released version the current commit is based on
 */
async function findClosestVersion(linkedRepoRoot: string, packageMeta: PackageMeta): Promise<string | undefined> {
    const versionsByCommit = new Map<string, string>()
    for (const pkg of Object.values(packageMeta.versions)) {
        if (pkg.gitHead) {
            versionsByCommit.set(pkg.gitHead, pkg.version)
        }
    }
    const stdout = await execa.stdout('git', ['log', '--format=%H'], { cwd: linkedRepoRoot })
    for (const commit of stdout.split('\n')) {
        const version = versionsByCommit.get(commit)
        if (version) {
            return version
        }
    }
    return undefined
}

const fetchPackageMeta = async (packageName: string): Promise<PackageMeta> => {
    const scope = packageName[0] === '@' ? packageName.split('/')[0] : undefined
    const registryUrl = getRegistryUrl(scope)
    const registryAuthToken = getAuthToken(registryUrl)
    const response = await got(new URL(packageName, registryUrl), {
        json: true,
        headers: {
            Authorization: registryAuthToken && 'Bearer ' + registryAuthToken.token,
        },
    })
    return response.body
}

const { bold } = chalk

async function check(linkedRepoRoot: string, pkgName: string): Promise<void> {
    let packageMeta: PackageMeta
    try {
        packageMeta = await fetchPackageMeta(pkgName)
    } catch (err) {
        if (err.statusCode === 404) {
            signale.warn(`Package ${bold(pkgName)} not found in npm registry`)
            return
        }
        throw err
    }
    const version = await findClosestVersion(linkedRepoRoot, packageMeta)
    if (!version) {
        signale.warn(`Did not find any released version for linked package ${bold(pkgName)}`)
        return
    }
    const pkgJson = JSON.parse(await readFile('package.json', 'utf-8')) as PackageJson
    const range = pkgJson.dependencies[pkgName]!
    if (semver.valid(range) ? semver.gte(version, range) : semver.satisfies(version, range)) {
        signale.success(
            `Linked repository for package ${bold(pkgName)} is based on ${bold(
                version
            )}, which is compatible with package.json requirement ${bold(range)}`
        )
    } else {
        const minVersion = semver.minSatisfying(Object.keys(packageMeta.versions), range)
        const minCommit = packageMeta.versions[minVersion]!.gitHead
        signale.error(
            `Linked repository for package ${bold(pkgName)} is based on ${bold(
                version
            )}, but package.json requires ${bold(range)}`
        )
        if (minCommit) {
            const minCommitShort = shortenCommit(minCommit)
            const linkedRepoRootRelative = path.relative(process.cwd(), linkedRepoRoot)
            signale.error(`Update ${bold(linkedRepoRootRelative)} at least to commit ${bold(minCommitShort)}`)
        }
    }
}

async function* findPackages(): AsyncIterable<{ name: string; path: string }> {
    for (const packageOrScope of await readdir('node_modules')) {
        const packageOrScopePath = path.resolve('node_modules', packageOrScope)

        if (packageOrScope[0] === '@') {
            for (const packageName of await readdir(path.join('node_modules', packageOrScope))) {
                yield { name: packageOrScope + '/' + packageName, path: path.join(packageOrScopePath, packageName) }
            }
        } else {
            yield { name: packageOrScope, path: packageOrScopePath }
        }
    }
}

async function* findLinkedPackages(): AsyncIterable<{ name: string; path: string }> {
    for await (const pkg of findPackages()) {
        const stats = await lstat(pkg.path)
        if (stats.isSymbolicLink()) {
            yield pkg
        }
    }
}

async function main(): Promise<void> {
    const argv = yargs
        .option('watch', { alias: 'w', description: 'Check when the git HEAD of linked package changes' })
        .help().argv
    const watchEnabled: boolean = argv.watch

    for await (const pkg of findLinkedPackages()) {
        const linkedRepoRoot = await findRepoRoot(await realpath(pkg.path))
        await check(linkedRepoRoot, pkg.name)
        if (watchEnabled) {
            const gitHeadFile = path.join(linkedRepoRoot, '.git', 'HEAD')
            const watcher = watch(gitHeadFile)
            watcher.on('change', async filePath => {
                signale.info(`Git HEAD change detected for linked package ${bold(pkg.name)}`)
                await check(linkedRepoRoot, pkg.name)
            })
        }
    }
    if (watchEnabled) {
        signale.watch('Watching for git HEAD changes')
    }
}

main().catch(err => {
    signale.fatal(err)
    process.exitCode = 1
})
