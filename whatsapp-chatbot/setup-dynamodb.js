/**
 * ===========================================
 * SCRIPT SIMPLIFICADO PARA CREAR TABLAS
 * ===========================================
 * 
 * Este script usa las credenciales del .env
 * NO usa AWS CLI (que está usando otro usuario)
 */

require('dotenv').config();
const { DynamoDBClient, CreateTableCommand, DescribeTableCommand } = require('@aws-sdk/client-dynamodb');

const logger = {
    info: console.log,
    error: console.error,
    warn: console.warn
};

// Cliente usando credenciales del .env
const dynamoClient = new DynamoDBClient({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

async function tableExists(tableName) {
    try {
        const command = new DescribeTableCommand({ TableName: tableName });
        await dynamoClient.send(command);
        return true;
    } catch (error) {
        if (error.name === 'ResourceNotFoundException') {
            return false;
        }
        throw error;
    }
}

async function createConversationsTable() {
    const tableName = 'norboy-conversations';

    console.log(`\n📋 Verificando tabla ${tableName}...`);

    if (await tableExists(tableName)) {
        console.log(`✅ Tabla ${tableName} ya existe - Saltando`);
        return;
    }

    console.log(`📋 Creando tabla ${tableName}...`);

    const command = new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [
            { AttributeName: 'participantId', AttributeType: 'S' }
        ],
        KeySchema: [
            { AttributeName: 'participantId', KeyType: 'HASH' }
        ],
        BillingMode: 'PAY_PER_REQUEST',
        Tags: [
            { Key: 'Project', Value: 'NORBOY' },
            { Key: 'Environment', Value: 'production' }
        ]
    });

    await dynamoClient.send(command);
    console.log(`✅ Tabla ${tableName} creada exitosamente`);
}

async function createMessagesTable() {
    const tableName = 'norboy-messages';

    console.log(`\n📨 Verificando tabla ${tableName}...`);

    if (await tableExists(tableName)) {
        console.log(`✅ Tabla ${tableName} ya existe - Saltando`);
        return;
    }

    console.log(`📋 Creando tabla ${tableName}...`);

    const command = new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [
            { AttributeName: 'messageId', AttributeType: 'S' },
            { AttributeName: 'participantId', AttributeType: 'S' },
            { AttributeName: 'timestamp', AttributeType: 'N' }
        ],
        KeySchema: [
            { AttributeName: 'messageId', KeyType: 'HASH' }
        ],
        GlobalSecondaryIndexes: [
            {
                IndexName: 'participantId-timestamp-index',
                KeySchema: [
                    { AttributeName: 'participantId', KeyType: 'HASH' },
                    { AttributeName: 'timestamp', KeyType: 'RANGE' }
                ],
                Projection: { ProjectionType: 'ALL' }
            }
        ],
        BillingMode: 'PAY_PER_REQUEST',
        Tags: [
            { Key: 'Project', Value: 'NORBOY' },
            { Key: 'Environment', Value: 'production' }
        ]
    });

    await dynamoClient.send(command);
    console.log(`✅ Tabla ${tableName} creada exitosamente`);

    // Esperar a que se cree el índice
    console.log('⏳ Esperando a que se cree el índice GSI...');
    await new Promise(resolve => setTimeout(resolve, 5000));
}

async function main() {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 CREACIÓN DE TABLAS DYNAMODB');
    console.log('='.repeat(60));

    console.log(`\n🔐 Usando credenciales:`);
    console.log(`   Access Key: ${process.env.AWS_ACCESS_KEY_ID}`);
    console.log(`   Región: ${process.env.AWS_REGION}`);

    try {
        await createConversationsTable();
        await createMessagesTable();

        console.log('\n' + '='.repeat(60));
        console.log('✅ ¡TABLAS LISTAS!');
        console.log('='.repeat(60));
        console.log('\n✨ Ahora puedes ejecutar: node check-dynamodb-messages.js');
        console.log('   para verificar que todo funciona\n');

    } catch (error) {
        console.error('\n' + '='.repeat(60));
        console.error('❌ ERROR AL CREAR TABLAS');
        console.error('='.repeat(60));
        console.error(`\nError: ${error.message}`);
        console.error(`Código: ${error.name}`);

        if (error.name === 'AccessDeniedException') {
            console.error('\n⚠️  PROBLEMA DE PERMISOS:');
            console.error('   El usuario de IAM NO tiene permisos para crear tablas.');
            console.error('   Necesitas agregar el permiso: dynamodb:CreateTable');
        }

        console.error('');
        process.exit(1);
    }
}

main();
