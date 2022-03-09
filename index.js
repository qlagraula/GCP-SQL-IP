import { got } from "got";
import { exec as _exec } from "child_process";
import { promisify } from "util";
import inquirer from "inquirer";
import fs from "fs";
import inquirerSearchList from "inquirer-search-list";
import ora from "ora";

const exec = promisify(_exec);
inquirer.registerPrompt("search-list", inquirerSearchList);

const getToken = async () => {
  const spinner = ora("Getting access token").start();
  const { stdout } = await exec("gcloud auth print-access-token");
  const token = stdout?.replace("\n", "");
  if (!token) {
    spinner.fail("Configure gcloud");
    return null;
  }
  spinner.succeed();
  return token;
};

const getNewIp = async () => {
  const spinner = ora("Getting current IP address").start();
  const newIp = await got.get("https://api.ipify.org");
  if (!newIp?.body) {
    spinner.fail();
    return null;
  }
  spinner.succeed();
  return `${newIp.body}/32`;
};

const getConfig = async () => {
  let projectId = null;
  let instanceId = null;
  let config = null;
  try {
    config = JSON.parse(fs.readFileSync("./config.json", "utf8"));
    projectId = config.projectId;
    instanceId = config.instanceId;
    console.log("PROJECT ID:  ", projectId);
    console.log("INSTANCE ID: ", instanceId);

    const { keepConfig } = await inquirer.prompt([
      {
        name: "keepConfig",
        type: "confirm",
        message: "Do you want to use this config?",
      },
    ]);
    if (!keepConfig) throw new Error();
  } catch (error) {
    const answers = await inquirer.prompt([
      {
        name: "projectId",
        type: "input",
        message: "Enter project id:  ",
      },
      {
        name: "instanceId",
        type: "input",
        message: "Enter instance id: ",
      },
    ]);
    projectId = answers.projectId;
    instanceId = answers.instanceId;
    fs.writeFileSync(
      "./config.json",
      JSON.stringify({
        ...config,
        projectId,
        instanceId,
      })
    );
  }

  return { ...config, projectId, instanceId };
};

const getCurrentIps = async (url, headers) => {
  const spinner = ora("Getting current whitelisted IP address").start();
  const currentSettings = await got.get(`${url}?fields=settings`, {
    headers,
  });

  const currentIps = JSON.parse(currentSettings?.body)?.settings
    ?.ipConfiguration?.authorizedNetworks;

  if (!currentIps) {
    spinner.fail();
    return null;
  }

  spinner.succeed();
  return currentIps;
};

const getName = async (config, currentIps) => {
  if (config.name) {
    const { keepConfig } = await inquirer.prompt([
      {
        name: "keepConfig",
        type: "confirm",
        message: `Do you want to update ${config.name}?`,
      },
    ]);
    if (keepConfig) return config.name;
  }
  const names = currentIps.map((ip) => ip.name);
  let { name } = await inquirer.prompt([
    {
      name: "name",
      type: "search-list",
      message: "Which IP do you want to update?",
      choices: [...names, "NEW VALUE"],
    },
  ]);
  if (name === "NEW VALUE") {
    const answer = await inquirer.prompt([
      {
        name: "name",
        type: "input",
        message: "Enter new name:  ",
      },
    ]);
    name = answer.name;
  }

  fs.writeFileSync(
    "./config.json",
    JSON.stringify({
      ...config,
      name,
    })
  );

  return name;
};

const updateIp = async (url, headers, name, newIp, currentIps) => {
  if (currentIps.some((ip) => ip.value === newIp && ip.name === name))
    return console.log("\x1b[32m%s\x1b[0m", `${name} IP is already up to date`);

  const spinner = ora("Updating whitelisted IP addresses").start();
  const newIps = [
    ...currentIps.filter((ip) => ip.value !== newIp && ip.name !== name),
    { kind: "sql#aclEntry", value: newIp, name },
  ];

  const result = await got.patch(url, {
    headers,
    body: JSON.stringify({
      settings: {
        ipConfiguration: {
          authorizedNetworks: newIps,
        },
      },
    }),
  });
  if (!result || result?.statusCode !== 200) {
    spinner.fail();
    return null;
  }
  spinner.succeed();
  console.log("\x1b[32m%s\x1b[0m", `${name} IP has been successfully updated`);
};

(async () => {
  try {
    const token = await getToken();
    if (!token) return null;

    const newIp = await getNewIp();
    if (!newIp) return null;

    const config = await getConfig();
    const headers = { Authorization: `Bearer ${token}` };
    const url = `https://sqladmin.googleapis.com/sql/v1beta4/projects/${config.projectId}/instances/${config.instanceId}`;

    const currentIps = await getCurrentIps(url, headers);
    if (!currentIps) return null;

    const name = await getName(config, currentIps);
    if (!name || !name.length) return ora("Empty name").fail();

    return updateIp(url, headers, name, newIp, currentIps);
  } catch (err) {
    console.log(err);
  }
})();
