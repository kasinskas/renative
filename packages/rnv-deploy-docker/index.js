/* eslint-disable global-require, import/no-dynamic-require */
import path from 'path';
import chalk from 'chalk';

class Docker {
    setRNVPath(pth) {
        this.rnvPath = pth;
    }

    async buildImage() {
        const { getConfigProp } = require(path.join(this.rnvPath, 'dist/core/common'));
        const { logTask, logInfo } = require(path.join(this.rnvPath, 'dist/core/systemManager/logger'));
        const config = require(path.join(this.rnvPath, 'dist/core/config')).default;
        const { executeAsync } = require(path.join(this.rnvPath, 'dist/core/systemManager/exec'));
        const { copyFolderRecursiveSync, cleanFolder, writeCleanFile } = require(path.join(this.rnvPath, 'dist/core/systemManager/fileutils'));

        const { paths, runtime, platform, files, program } = config.getConfig();
        const projectBuilds = paths.project.builds.dir;
        const projectBuildWeb = path.join(projectBuilds, `${runtime.appId}_${platform}`);
        const dockerDestination = path.join(projectBuildWeb, 'export', 'docker');
        const buildDir = program.engine === 'next' ? 'out' : 'public';

        const dockerFile = path.join(__dirname, '../Dockerfile');
        const nginxConfFile = path.join(__dirname, '../nginx/default.conf');
        const dockerComposeBuildFile = path.join(__dirname, '../docker-compose.build.yml');
        const dockerComposeFile = path.join(__dirname, '../docker-compose.yml');

        await cleanFolder(path.join(dockerDestination));
        copyFolderRecursiveSync(path.join(projectBuildWeb, buildDir), dockerDestination);

        const copiedDockerFile = path.join(dockerDestination, 'Dockerfile');
        const copiedNginxConfFile = path.join(dockerDestination, 'nginx.default.conf');
        const copiedDockerComposeBuildFile = path.join(dockerDestination, 'docker-compose.build.yml');
        const copiedDockerComposeFile = path.join(dockerDestination, 'docker-compose.yml');

        const imageName = runtime.appId.toLowerCase();
        const appVersion = files.project.package.version;

        // save the docker files
        logTask('docker:Dockerfile:create');
        const deployOptions = getConfigProp(config.getConfig(), platform, 'deploy');
        const healthCheck = deployOptions?.docker?.healthcheckProbe;

        let additionalCommands = '';

        if (healthCheck) {
            additionalCommands = 'RUN touch /var/www/localhost/htdocs/testprobe.html';
        }

        writeCleanFile(dockerFile, copiedDockerFile, [
            { pattern: '{{BUILD_FOLDER}}', override: buildDir },
            { pattern: '{{DOCKER_ADDITIONAL_COMMANDS}}', override: additionalCommands }
        ]);

        writeCleanFile(nginxConfFile, copiedNginxConfFile);
        writeCleanFile(dockerComposeBuildFile, copiedDockerComposeBuildFile);
        writeCleanFile(dockerComposeFile, copiedDockerComposeFile, [
            { pattern: '{{IMAGE_AND_TAG}}', override: `${imageName}:${appVersion}` },
        ]);

        logTask('docker:Dockerfile:build');
        await executeAsync(`docker build -t ${imageName}:${appVersion} ${dockerDestination}`);

        logInfo(`Your Dockerfile and docker-compose.yml are located in ${dockerDestination}`);
    }

    async saveImage() {
        const { getConfigProp } = require(path.join(this.rnvPath, 'dist/core/common'));
        const config = require(path.join(this.rnvPath, 'dist/core/config')).default;
        const { runtime, files, paths, platform, program: { scheme = 'debug' } } = config.getConfig();
        const { logTask, logInfo, logSuccess } = require(path.join(this.rnvPath, 'dist/core/systemManager/logger'));
        const { executeAsync, commandExistsSync } = require(path.join(this.rnvPath, 'dist/core/systemManager/exec'));
        const imageName = runtime.appId.toLowerCase();
        const appVersion = files.project.package.version;

        const projectBuilds = paths.project.builds.dir;
        const projectBuildWeb = path.join(projectBuilds, `${runtime.appId}_${platform}`);
        const dockerDestination = path.join(projectBuildWeb, 'export', 'docker');
        const dockerSaveFile = path.join(dockerDestination, `${imageName}_${appVersion}.tar`);

        logTask('docker:Dockerfile:build');
        await executeAsync(`docker save -o ${dockerSaveFile} ${imageName}:${appVersion}`);
        logSuccess(`${imageName}_${appVersion}.tar file has been saved in ${chalk.white(dockerDestination)}. You can import it on another machine by running ${chalk.white(`'docker load -i ${imageName}_${appVersion}.tar'`)}`);
        logSuccess(`You can also test it locally by running the following command: ${chalk.white(`'docker run -d --rm -p 8081:80 -p 8443:443 ${imageName}:${appVersion}'`)} and then opening ${chalk.white('http://localhost:8081')}`);

        const deployOptions = getConfigProp(config.getConfig(), platform, 'deploy');
        const zipImage = deployOptions?.docker?.zipImage;

        if (zipImage) {
            logTask('docker:zipImage');
            if (commandExistsSync('zip')) {
                const pth = `${dockerDestination}${path.sep}`;
                await executeAsync(`zip -j ${pth}web_${imageName}_${scheme}_${appVersion}.zip ${pth}${imageName}_${appVersion}.tar ${pth}docker-compose.yml`);
            }
        }
    }

    async doExport() {
        await this.buildImage();
        return this.saveImage();
    }

    async doDeploy() {
    // rnv paths
        const config = require(path.join(this.rnvPath, 'dist/core/config')).default;
        const { inquirerPrompt } = require(path.join(this.rnvPath, 'dist/core/systemManager/prompt'));
        const { logInfo, logTask } = require(path.join(this.rnvPath, 'dist/core/systemManager/logger'));
        const { executeAsync } = require(path.join(this.rnvPath, 'dist/core/systemManager/exec'));

        const { runtime, files } = config.getConfig();

        await this.buildImage();

        let { DOCKERHUB_USER, DOCKERHUB_PASS } = process.env;

        // ask for user/pass if not present in env
        if (!DOCKERHUB_PASS || !DOCKERHUB_USER) {
            const { confirm } = await inquirerPrompt({
                type: 'confirm',
                message: 'It seems you don\'t have the DOCKERHUB_USER and DOCKERHUB_PASS environment variables set. Do you want to enter them here?'
            });

            if (confirm) {
                const { user } = await inquirerPrompt({
                    name: 'user',
                    type: 'input',
                    message: 'DockerHub username',
                    validate: i => !!i || 'No username provided'
                });
                DOCKERHUB_USER = user;
                const { pass } = await inquirerPrompt({
                    name: 'pass',
                    type: 'password',
                    message: 'DockerHub password',
                    validate: i => !!i || 'No password provided'
                });
                DOCKERHUB_PASS = pass;
            } else {
                return logInfo('You chose to not publish the image on DockerHub. The Dockerfile is located in the root folder');
            }
        }

        const imageName = runtime.appId.toLowerCase();
        const imageTag = `${DOCKERHUB_USER}/${imageName}`;
        const appVersion = files.project.package.version;

        logTask('docker:Dockerfile:login');
        await executeAsync(`echo "${DOCKERHUB_PASS}" | docker login -u "${DOCKERHUB_USER}" --password-stdin`, { interactive: true });
        logTask('docker:Dockerfile:push');
        // tagging for versioning
        await executeAsync(`docker tag ${imageName}:${appVersion} ${imageTag}:${appVersion}`);
        await executeAsync(`docker tag ${imageName}:${appVersion} ${imageTag}:latest`);
        await executeAsync(`docker push ${imageTag}:${appVersion}`);
        await executeAsync(`docker push ${imageTag}:latest`);
        return true;
    }
}

export default new Docker();
