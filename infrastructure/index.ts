import * as pulumi from "@pulumi/pulumi";
import * as resources from "@pulumi/azure-native/resources";
import * as containerregistry from "@pulumi/azure-native/containerregistry";
import * as docker from '@pulumi/docker';
import * as containerinstance from '@pulumi/azure-native/containerinstance';
import * as cache from '@pulumi/azure-native/cache'

// Import the configuration settings for the current stack.
const config = new pulumi.Config();
const appPath = config.require("appPath");
const prefixName = config.require("prefixName"); // This will be used instead of "parm0100"
const imageName = prefixName;
const imageTag = config.require("imageTag");
const containerPort = config.requireNumber("containerPort");
const publicPort = config.requireNumber("publicPort");
const cpu = config.requireNumber("cpu");
const memory = config.requireNumber("memory");

// Sanitize prefixName to create a valid Azure Container Registry name.
const sanitizedPrefixName = prefixName.replace(/[^a-zA-Z0-9]/g, "");

// Create a resource group.
const resourceGroup = new resources.ResourceGroup(`${prefixName}-rg`);

// Create a managed Redis service
const redis = new cache.Redis(`${prefixName}-redis`, {
  name: `${prefixName}-weather-cache`,
  location: 'westus3',
  resourceGroupName: resourceGroup.name,
  enableNonSslPort: true,
  redisVersion: 'Latest',
  minimumTlsVersion: '1.2',
  redisConfiguration: {
    maxmemoryPolicy: 'allkeys-lru'
  },
  sku: {
    name: 'Basic',
    family: 'C',
    capacity: 0
  }
})

const redisAccessKey = cache
  .listRedisKeysOutput({ name: redis.name, resourceGroupName: resourceGroup.name })
  .apply((keys) => keys.primaryKey)

// Construct the Redis connection string to be passed as an environment variable in the app container
const redisConnectionString = pulumi.interpolate`rediss://:${redisAccessKey}@${redis.hostName}:${redis.sslPort}`


// Create the container registry with a sanitized name.
const registry = new containerregistry.Registry(`${sanitizedPrefixName}ACR`, {
  resourceGroupName: resourceGroup.name,
  adminUserEnabled: true,
  sku: {
    name: containerregistry.SkuName.Basic,
  },
});

// Get the authentication credentials for the container registry.
const registryCredentials = containerregistry
  .listRegistryCredentialsOutput({
    resourceGroupName: resourceGroup.name,
    registryName: registry.name,
  })
  .apply((creds) => {
    return {
      username: creds.username!,
      password: creds.passwords![0].value!,
    };
  });

// Define the container image for the service.
const image = new docker.Image(`${prefixName}-image`, {
  imageName: pulumi.interpolate`${registry.loginServer}/${imageName}:${imageTag}`,
  build: {
    context: appPath,
    platform: "linux/amd64",
  },
  registry: {
    server: registry.loginServer,
    username: registryCredentials.apply(creds => creds.username),  // Using apply to get value
    password: registryCredentials.apply(creds => creds.password),  // Using apply to get value
  },
});

// Create a container group in the Azure Container App service and make it publicly accessible.
const containerGroup = new containerinstance.ContainerGroup(
  `${prefixName}-container-group`,
  {
    resourceGroupName: resourceGroup.name,
    osType: 'linux',
    restartPolicy: 'always',
    imageRegistryCredentials: [
      {
        server: registry.loginServer,
        username: registryCredentials.apply(creds => creds.username),  // Using apply to get value
        password: registryCredentials.apply(creds => creds.password),  // Using apply to get value
      },
    ],
    containers: [
      {
        name: imageName,
        image: image.imageName,
        ports: [
          {
            port: containerPort,
            protocol: 'tcp',
          },
        ],
        environmentVariables: [
          {
            name: 'PORT',
            value: containerPort.toString(),
          },
          {
            name: 'WEATHER_API_KEY',
            value: config.requireSecret('weatherApiKey'),
          },
          {
            name: 'REDIS_URL',
            value: redisConnectionString
          },
        ],
        resources: {
          requests: {
            cpu: cpu,
            memoryInGB: memory,
          },
        },
      },
    ],
    ipAddress: {
      type: containerinstance.ContainerGroupIpAddressType.Public,
      dnsNameLabel: `${imageName}`,
      ports: [
        {
          port: publicPort,
          protocol: 'tcp',
        },
      ],
    },
  }
);

// Export the service's IP address, hostname, and fully-qualified URL.
export const hostname = containerGroup.ipAddress.apply((addr) => addr!.fqdn!);
export const ip = containerGroup.ipAddress.apply((addr) => addr!.ip!);
export const url = containerGroup.ipAddress.apply(
  (addr) => `http://${addr!.fqdn!}:${containerPort}`
);

export const acrServer = registry.loginServer
export const acrUsername = registryCredentials.username