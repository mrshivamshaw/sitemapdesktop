const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const axios = require('axios');
const Store = require('electron-store');

// Configuration for storing license and machine info
const store = new Store();

// Configuration for the license server
const LICENSE_SERVER_URL = 'https://abcsitemap.com/license/validate'; // Replace with your actual license server URL

// Function to generate a unique hardware fingerprint
function generateHardwareFingerprint() {
    const hardwareInfo = {
        cpuid: os.cpus()[0].model,
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        mac: getMacAddress()
    };

    // Create a hash of the hardware information
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(hardwareInfo))
        .digest('hex');
}

// Function to get MAC address (this is a simplified example)
function getMacAddress() {
    const networkInterfaces = os.networkInterfaces();
    for (const interfaceName in networkInterfaces) {
        const interfaces = networkInterfaces[interfaceName];
        for (const iface of interfaces) {
            if (!iface.internal && iface.mac !== '00:00:00:00:00:00') {
                return iface.mac;
            }
        }
    }
    return 'unknown';
}

let mainWindow;
let licenseValidated = false;

const loadMainWindow = () => {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        icon: path.join(__dirname, 'icon.ico')
    });
    mainWindow.loadFile('index.html');
}

function createWindow() {
    // Check if license is already validated
    // store.delete('licenseKey');
    // store.delete('hardwareFingerprint');
    const savedLicenseKey = store.get('licenseKey');
    const hardwareFingerprint = generateHardwareFingerprint();

    // console.log('Saved License Key:', savedLicenseKey);
    // console.log('Hardware Fingerprint:', hardwareFingerprint);

    if (!savedLicenseKey) {
        // Show license key input window
        showLicenseKeyInput(hardwareFingerprint);
    } else {
        // Validate existing license
        validateLicense(savedLicenseKey, hardwareFingerprint);
        loadMainWindow();
    }
}

function showLicenseKeyInput(hardwareFingerprint) {
    const licenseWindow = new BrowserWindow({
        width: 400,
        height: 300,
        modal: true,
        parent: mainWindow,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        icon: path.join(__dirname, 'icon.ico')
    });

    licenseWindow.loadFile('license-input.html');

    // Handle license key submission
    ipcMain.once('submit-license-key', async (event, licenseKey) => {
        try {
            const isValid = await validateLicense(licenseKey, hardwareFingerprint);

            if (isValid) {
                // Save license key and hardware fingerprint
                store.set('licenseKey', licenseKey);
                store.set('hardwareFingerprint', hardwareFingerprint);
                
                licenseWindow.close();
                loadMainWindow();
            } else {
                // Show error message
                event.reply('license-validation-error', 'Invalid license key or already activated on another device');
            }
        } catch (error) {
            event.reply('license-validation-error', 'Error validating license: ' + error.message);
        }
    });
}

async function validateLicense(licenseKey, hardwareFingerprint) {
    try {
        console.log('Validating license...', licenseKey, hardwareFingerprint);
        
        const response = await axios.post(LICENSE_SERVER_URL, {
            "license_key" : licenseKey,
            "hardware_fingerprint":hardwareFingerprint
        });

        // Check if license is valid and matches the current hardware
        if (response.data.valid) {
            licenseValidated = true;
            console.log('License validated successfully');
            
            return true;
        }
        store.delete('licenseKey');
        store.delete('hardwareFingerprint');
        return false;
    } catch (error) {
        console.error('License validation error:', error);
        store.delete('licenseKey');
        store.delete('hardwareFingerprint');
        // Show error dialog
        dialog.showErrorBox(
            'License Validation Failed', 
            'Unable to validate license. Please check your internet connection and try again.'
        );

        return false;
    }
}

// IPC handler to check license status before generating sitemap
ipcMain.handle('check-license', () => {
    return licenseValidated;
});

app.on('ready', createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (mainWindow === null) createWindow();
});