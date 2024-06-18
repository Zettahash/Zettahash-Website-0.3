import json

# Replace this with the path to your service account JSON file
service_account_file = './service-account-file.json'

with open(service_account_file, 'r') as file:
    service_account_json = json.load(file)

formatted_json_string = json.dumps(service_account_json)

# Print the correctly formatted JSON string
print(formatted_json_string)