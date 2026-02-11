# ✅ GUÍA PASO A PASO - APLICAR PERMISOS AWS IAM

## 🚨 DEBES HACER ESTO MANUALMENTE (yo no puedo acceder a tu cuenta de AWS)

### Paso 1: Entrar a AWS IAM Console

1. Ve a: https://console.aws.amazon.com/iam/
2. Inicia sesión con tu cuenta de AWS
3. En el menú izquierdo, haz clic en **"Users"** (Usuarios)

### Paso 2: Buscar el usuario IAM

1. Busca el usuario que tiene la Access Key: **AKIAQ3E7KVPPZGS4SBLB**
   - Puede aparecer en la lista con un nombre como "norboy-bot-user" o similar
   - Si no sabes cuál es, haz clic en cada usuario y ve a la pestaña **"Security credentials"**
   - Busca el que tenga el Access Key ID que empieza con **AKIAQ3E7KVPPZGS...**

### Paso 3: Añadir la política de permisos

1. Una vez identificado el usuario, haz clic en su nombre
2. Haz clic en la pestaña **"Permissions"** (Permisos)
3. Haz clic en el botón **"Add permissions"** → **"Create inline policy"**
4. En el editor de políticas:
   - Si te muestra un editor visual, haz clic en la pestaña **"JSON"**
   - **BORRA** todo el contenido que haya en el editor
   - **COPIA Y PEGA** exactamente esto:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "NorboyDynamoDBFullAccess",
      "Effect": "Allow",
      "Action": [
        "dynamodb:PutItem",
        "dynamodb:GetItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:BatchWriteItem",
        "dynamodb:BatchGetItem",
        "dynamodb:DescribeTable",
        "dynamodb:ListTables"
      ],
      "Resource": [
        "arn:aws:dynamodb:us-east-1:*:table/norboy-conversations",
        "arn:aws:dynamodb:us-east-1:*:table/norboy-messages",
        "arn:aws:dynamodb:us-east-1:*:table/norboy-holidays",
        "arn:aws:dynamodb:us-east-1:*:table/norboy-conversations/index/*",
        "arn:aws:dynamodb:us-east-1:*:table/norboy-messages/index/*"
      ]
    }
  ]
}
```

5. Haz clic en **"Next"** (Siguiente)
6. Dale un nombre a la política: **NorboyDynamoDBAccess**
7. Haz clic en **"Create policy"** (Crear política)

### Paso 4: Verificar que se aplicó correctamente

1. Deberías ver la nueva política en la lista de permisos del usuario
2. El nombre debe ser **NorboyDynamoDBAccess**
3. Debe aparecer como tipo **"Inline policy"**

## ✅ DESPUÉS DE APLICAR LA POLÍTICA

### Vuelve aquí y escribe: "listo"

Cuando escribas "listo", voy a:
1. Probar la conexión a DynamoDB
2. Crear las tablas si no existen
3. Verificar que los mensajes se guarden correctamente
4. Probar que el frontend pueda ver los mensajes

---

## 🔍 SOLUCIÓN DE PROBLEMAS

### Si ves error "Access Denied" después de aplicar la política:

1. Espera 1-2 minutos (AWS puede tardar en propagar los permisos)
2. Verifica que copiaste TODO el JSON correctamente
3. Verifica que el usuario sea el correcto (con el Access Key que empieza con AKIAQ3E7KVPPZGS...)

### Si no encuentras el usuario:

- Es posible que el Access Key sea de otro usuario o cuenta
- Verifica en qué cuenta de AWS estás logueado
- Si usas múltiples cuentas, asegúrate de estar en la correcta

### Si no tienes acceso a AWS Console:

- Necesitas pedir a alguien con permisos de administrador que aplique esta política
- Envíales este archivo con las instrucciones
